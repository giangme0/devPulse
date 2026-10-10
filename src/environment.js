import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function createEnvironment({ projectRoot = root, env = process.env, envFile = true } = {}) {
  let values = {};
  if (envFile) {
    try {
      values = parseEnv(fs.readFileSync(path.join(projectRoot, ".env"), "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error("Không thể đọc cấu hình .env");
    }
  }
  return {
    logging() {
      return {
        level: env.LOG_LEVEL ?? values.LOG_LEVEL ?? "info",
        format: env.LOG_FORMAT ?? values.LOG_FORMAT ?? "text",
      };
    },
    secret(name, saved = "") {
      if (env[name]?.trim()) return { value: env[name], source: "system" };
      if (values[name]?.trim()) return { value: values[name], source: "dotenv" };
      if (saved?.trim()) return { value: saved, source: "settings" };
      return { value: "", source: "none" };
    },
    runtime() {
      const rawPort = env.PORT ?? values.PORT ?? "3000";
      if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535)
        throw new Error("PORT phải là số nguyên từ 1 đến 65535");
      const dir = env.DEVPULSE_DATA_DIR ?? values.DEVPULSE_DATA_DIR ?? "./data";
      if (typeof dir !== "string" || !dir.trim() || dir.includes("\0"))
        throw new Error("DEVPULSE_DATA_DIR không hợp lệ");
      return { port: Number(rawPort), dataDir: path.resolve(projectRoot, dir) };
    },
  };
}

export function prepareDataDir(dir) {
  let probe;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    probe = fs.mkdtempSync(path.join(dir, ".write-check-"));
    fs.writeFileSync(path.join(probe, "probe"), "", { mode: 0o600 });
  } catch {
    throw new Error("Không thể ghi thư mục dữ liệu (DEVPULSE_DATA_DIR); kiểm tra đường dẫn và quyền truy cập");
  } finally {
    if (probe) {
      try {
        fs.rmSync(probe, { recursive: true, force: true });
      } catch {
        throw new Error("Không thể dọn kiểm tra quyền ghi thư mục dữ liệu; kiểm tra quyền truy cập");
      }
    }
  }
}

export const environment = createEnvironment();