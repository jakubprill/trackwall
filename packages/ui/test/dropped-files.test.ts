import { expect, test } from "bun:test";
import { MAX_DROP_BYTES } from "@trackwall/protocol";
import { carriesFiles, copyingNotice, droppedBytes, droppedFileName, dropRefusal, sendDropped } from "../src/lib/dropped-files.ts";

test("a dropped file keeps the last part of its path, whether the computer writes / or \\", () => {
  expect(droppedFileName("/Users/dana/Downloads/build.log")).toBe("build.log");
  expect(droppedFileName("C:\\Users\\dana\\Downloads\\screen shot.png")).toBe("screen shot.png");
  expect(droppedFileName("/Users/dana/Downloads/folder/")).toBe("folder");
});

test("only a drag that carries files from the system is taken, not dragged text or a link", () => {
  expect(carriesFiles(["Files"])).toBe(true);
  expect(carriesFiles(["text/plain", "text/uri-list"])).toBe(false);
});

test("a file over the limit or a folder is refused before any of it is read; any name goes, the daemon makes it safe", () => {
  expect(dropRefusal({ name: "build.log", size: 10 })).toBeUndefined();
  expect(dropRefusal({ name: "what?.png", size: 1 })).toBeUndefined();
  expect(dropRefusal({ name: "dump.hprof", size: MAX_DROP_BYTES + 1 })).toBe(
    "dump.hprof is larger than 256 MB; copy it into the container with docker cp instead",
  );
  expect(dropRefusal({ name: "reports", size: 0, folder: true })).toBe(
    "reports is a folder; only files can be dropped on a terminal in a container",
  );
});

test("the shell's answer counts as a file's bytes only when it is an ArrayBuffer", () => {
  const bytes = new ArrayBuffer(3);
  expect(droppedBytes(bytes)).toBe(bytes);
  expect(() => droppedBytes([1, 2, 3])).toThrow("read_dropped_file did not answer with the file's bytes");
});

test("the line above the terminal names one file, or counts several", () => {
  expect(copyingNotice([{ name: "build.log" }])).toBe("Copying build.log to Trackwall…");
  expect(copyingNotice([{ name: "a.png" }, { name: "b.png" }])).toBe("Copying 2 files to Trackwall…");
});

test("dropped files are sent in order and the terminal gets the paths of the copies", async () => {
  const sent: string[] = [];
  const paths = await sendDropped(
    [
      { name: "one.txt", read: async () => new Blob(["1"]) },
      { name: "two.txt", read: async () => new Blob(["2"]) },
    ],
    async (name) => {
      sent.push(name);
      return `/projects/.trackwall/drops/drop-a/${name}`;
    },
  );
  expect(sent).toEqual(["one.txt", "two.txt"]);
  expect(paths).toEqual(["/projects/.trackwall/drops/drop-a/one.txt", "/projects/.trackwall/drops/drop-a/two.txt"]);
});

test("one refused file stops the whole drop before anything is sent, so no path is pasted without the others", async () => {
  const sent: string[] = [];
  const sending = sendDropped(
    [
      { name: "small.txt", read: async () => new Blob(["1"]) },
      { name: "huge.bin", size: MAX_DROP_BYTES + 1, read: async () => new Blob([]) },
    ],
    async (name) => {
      sent.push(name);
      return name;
    },
  );
  await expect(sending).rejects.toThrow("huge.bin is larger than");
  expect(sent).toEqual([]);
});
