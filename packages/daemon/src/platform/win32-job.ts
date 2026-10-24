/**
 * Job Object przez `bun:ffi`, bez natywnego addonu (spike `spikes/job-objects`, ADR-1). Ładowany tylko pod Bun
 * na Windowsie. Układy struktur dla x64; ARM64 Windows ma ten sam układ.
 */
import { dlopen, FFIType, type Pointer } from "bun:ffi";

const JobObjectBasicAccountingInformation = 1;
const JobObjectExtendedLimitInformation = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const PROCESS_TERMINATE = 0x0001;
const PROCESS_SET_QUOTA = 0x0100;
/** sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION) na x64; LimitFlags pod offsetem 16. */
const EXTENDED_LIMIT_SIZE = 144;
const LIMIT_FLAGS_OFFSET = 16;
/** sizeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION); ActiveProcesses po czterech LARGE_INTEGER i dwóch DWORD. */
const ACCOUNTING_SIZE = 48;
const ACTIVE_PROCESSES_OFFSET = 40;

const k32 = dlopen("kernel32.dll", {
  CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
  SetInformationJobObject: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  QueryInformationJobObject: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
  AssignProcessToJobObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  TerminateJobObject: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
  CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
  GetLastError: { args: [], returns: FFIType.u32 },
});
const f = k32.symbols;

function fail(what: string): never {
  throw new Error(`${what} failed, GetLastError=${f.GetLastError()}`);
}

/**
 * Job z `KILL_ON_JOB_CLOSE`: system zabija wszystkie jego procesy, gdy zamknie się ostatni uchwyt, także przy
 * twardym zabiciu daemona, więc grupy procesów na Windowsie nie zostają sierotami.
 */
export class Job {
  private handle: Pointer | null;

  constructor() {
    this.handle = (f.CreateJobObjectW(null, null) as Pointer | null) ?? fail("CreateJobObjectW");
    const info = new Uint8Array(EXTENDED_LIMIT_SIZE);
    new DataView(info.buffer).setUint32(LIMIT_FLAGS_OFFSET, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, true);
    if (!f.SetInformationJobObject(this.handle, JobObjectExtendedLimitInformation, info, info.byteLength)) {
      this.close();
      fail("SetInformationJobObject");
    }
  }

  /** Potomkowie procesu utworzeni po przypisaniu trafiają do joba sami. */
  assign(pid: number): void {
    const proc = (f.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid) as Pointer | null) ?? fail(`OpenProcess(${pid})`);
    try {
      if (!f.AssignProcessToJobObject(this.requireHandle(), proc)) fail(`AssignProcessToJobObject(${pid})`);
    } finally {
      f.CloseHandle(proc);
    }
  }

  activeProcesses(): number {
    const buf = new Uint8Array(ACCOUNTING_SIZE);
    if (!f.QueryInformationJobObject(this.requireHandle(), JobObjectBasicAccountingInformation, buf, buf.byteLength, null)) {
      fail("QueryInformationJobObject");
    }
    return new DataView(buf.buffer).getUint32(ACTIVE_PROCESSES_OFFSET, true);
  }

  terminate(exitCode: number): void {
    if (!f.TerminateJobObject(this.requireHandle(), exitCode)) fail("TerminateJobObject");
  }

  close(): void {
    if (this.handle) f.CloseHandle(this.handle);
    this.handle = null;
  }

  private requireHandle(): Pointer {
    return this.handle ?? fail("job closed");
  }
}
