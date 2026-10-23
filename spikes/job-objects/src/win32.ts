/**
 * Job Objects przez `bun:ffi` bez natywnego addonu. To jest kandydat na `daemon/src/platform/win32/job.ts`.
 * Układy struktur dla x64; ARM64 Windows ma ten sam układ.
 */
import { dlopen, FFIType, type Pointer } from "bun:ffi";

const JobObjectBasicProcessIdList = 3;
const JobObjectExtendedLimitInformation = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const PROCESS_TERMINATE = 0x0001;
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
/** sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION) na x64; LimitFlags pod offsetem 16. */
const EXTENDED_LIMIT_SIZE = 144;
const LIMIT_FLAGS_OFFSET = 16;

const k32 = dlopen("kernel32.dll", {
  CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
  SetInformationJobObject: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  QueryInformationJobObject: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
  AssignProcessToJobObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  TerminateJobObject: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  IsProcessInJob: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
  CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
  GetLastError: { args: [], returns: FFIType.u32 },
});
const f = k32.symbols;

function fail(what: string): never {
  throw new Error(`${what} nie powiodło się, GetLastError=${f.GetLastError()}`);
}

function openProcess(pid: number): Pointer {
  const h = f.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  return (h as Pointer | null) ?? fail(`OpenProcess(${pid})`);
}

export class Job {
  private handle: Pointer | null;

  constructor(killOnClose = true) {
    this.handle = (f.CreateJobObjectW(null, null) as Pointer | null) ?? fail("CreateJobObjectW");
    if (killOnClose) {
      const info = new Uint8Array(EXTENDED_LIMIT_SIZE);
      new DataView(info.buffer).setUint32(LIMIT_FLAGS_OFFSET, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, true);
      if (!f.SetInformationJobObject(this.handle, JobObjectExtendedLimitInformation, info, info.byteLength)) {
        fail("SetInformationJobObject");
      }
    }
  }

  assign(pid: number): void {
    const proc = openProcess(pid);
    try {
      if (!f.AssignProcessToJobObject(this.requireHandle(), proc)) fail(`AssignProcessToJobObject(${pid})`);
    } finally {
      f.CloseHandle(proc);
    }
  }

  /** PID-y procesów, które system przypisał do joba (także potomkowie utworzeni po przypisaniu). */
  pids(): number[] {
    const buf = new Uint8Array(8 + 8 * 256);
    if (!f.QueryInformationJobObject(this.requireHandle(), JobObjectBasicProcessIdList, buf, buf.byteLength, null)) {
      fail("QueryInformationJobObject");
    }
    const view = new DataView(buf.buffer);
    const n = view.getUint32(4, true);
    return Array.from({ length: n }, (_, i) => Number(view.getBigUint64(8 + i * 8, true)));
  }

  terminate(exitCode = 1): void {
    if (!f.TerminateJobObject(this.requireHandle(), exitCode)) fail("TerminateJobObject");
  }

  close(): void {
    if (this.handle) f.CloseHandle(this.handle);
    this.handle = null;
  }

  private requireHandle(): Pointer {
    return this.handle ?? fail("job zamknięty");
  }
}

/** Czy proces jest już w jakimś jobie (np. daemon uruchomiony z terminala VS Code albo przez runner CI). */
export function isInAnyJob(pid: number): boolean {
  const proc = openProcess(pid);
  try {
    const out = new Int32Array(1);
    if (!f.IsProcessInJob(proc, null, out)) fail("IsProcessInJob");
    return out[0] !== 0;
  } finally {
    f.CloseHandle(proc);
  }
}
