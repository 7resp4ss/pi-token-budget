/** Atomic local persistence shared by independently running agents. */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

export function atomicWrite(file: string, contents: string, stagingDir = path.dirname(file)): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.mkdirSync(stagingDir, { recursive: true });
	const temporary = path.join(stagingDir, `.pi-budget-${process.pid}-${randomUUID()}.tmp`);
	try {
		fs.writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600 });
		fs.renameSync(temporary, file);
	} finally {
		fs.rmSync(temporary, { force: true });
	}
}

/** No await in the critical section: safe for both SDK sessions and processes.
 * A dead owner's lock is reclaimed; a live slow writer is never evicted. */
export function withFileLock<T>(file: string, action: () => T): T {
	const lock = `${file}.lock`;
	fs.mkdirSync(path.dirname(lock), { recursive: true });
	const deadline = Date.now() + 5000;
	for (;;) {
		try {
			fs.mkdirSync(lock);
			fs.writeFileSync(path.join(lock, "owner"), String(process.pid));
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			let abandoned = false;
			try {
				const pid = Number(fs.readFileSync(path.join(lock, "owner"), "utf8"));
				if (Number.isInteger(pid) && pid > 0) {
					try { process.kill(pid, 0); } catch (e) { abandoned = (e as NodeJS.ErrnoException).code === "ESRCH"; }
				}
			} catch {
				try { abandoned = Date.now() - fs.statSync(lock).mtimeMs > 30_000; } catch { continue; }
			}
			if (abandoned) {
				// Serialize reclaimers and re-check ownership. Without this, a
				// second stale observer could delete a newly acquired live lock.
				const reclaim = `${lock}.reclaim`;
				try {
					fs.mkdirSync(reclaim);
					try {
						let stillAbandoned = false;
						try {
							const owner = Number(fs.readFileSync(path.join(lock, "owner"), "utf8"));
							if (Number.isInteger(owner) && owner > 0) {
								try { process.kill(owner, 0); } catch (e) { stillAbandoned = (e as NodeJS.ErrnoException).code === "ESRCH"; }
							}
						} catch {
							try { stillAbandoned = Date.now() - fs.statSync(lock).mtimeMs > 30_000; } catch { /* already released */ }
						}
						if (stillAbandoned) fs.rmSync(lock, { recursive: true, force: true });
					} finally { fs.rmSync(reclaim, { recursive: true, force: true }); }
				} catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
			}
			if (Date.now() >= deadline) throw new Error(`Timed out waiting for storage lock: ${file}`);
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
		}
	}
	try { return action(); } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}

export function readJson<T>(file: string): T | undefined {
	try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export const charLength = (text: string): number => Array.from(text).length;
export const charSlice = (text: string, start: number, end?: number): string => Array.from(text).slice(start, end).join("");
