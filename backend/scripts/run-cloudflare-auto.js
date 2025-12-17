// scripts/run-cloudflare-auto.js
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

const PORT = process.env.PORT || 8000;

/* ---------------------------------------------
   Locate cloudflared binary cross-platform
--------------------------------------------- */
function findCloudflared() {
    const isWin = os.platform() === "win32";
    const exeName = isWin ? "cloudflared.exe" : "cloudflared";
    const sep = isWin ? ";" : ":";

    const pathEnv = process.env.PATH || process.env.Path || "";
    const dirs = pathEnv.split(sep).filter(Boolean);

    for (const dir of dirs) {
        const full = path.join(dir.trim(), exeName);
        if (fs.existsSync(full)) {
            return full;
        }
    }

    // fallback to system PATH resolution
    return exeName;
}

const cloudflaredPath = findCloudflared();
console.log("[Tunnel] Using binary:", cloudflaredPath);

/* ---------------------------------------------
   Start cloudflare tunnel
--------------------------------------------- */
const child = spawn(cloudflaredPath, [
    "tunnel",
    "--url",
    `http://localhost:${PORT}`,
]);

console.log("[Tunnel] Starting Cloudflare quick tunnel…");

child.on("error", (err) => {
    console.error("[Tunnel] Failed to start cloudflared:", err);
    console.error(`
Possible fix:
  1. Restart VS Code (refreshes PATH)
  2. Or add cloudflared to PATH manually:
     $env:Path += ';C:\\Program Files\\Cloudflare\\Cloudflared'
`);
});

/* ---------------------------------------------
   Watch cloudflared output for the generated URL
--------------------------------------------- */
child.stdout.on("data", (data) => {
    const text = data.toString();
    process.stdout.write("[cloudflared] " + text);

    const match = text.match(/https:\/\/[^\s]+\.trycloudflare\.com/);
    if (match) {
        const url = match[0].trim();
        console.log("\n[Tunnel] Public URL detected:", url);

        const envFile = path.join(process.cwd(), ".env");
        let envText = "";

        if (fs.existsSync(envFile)) {
            envText = fs.readFileSync(envFile, "utf8");

            if (envText.includes("PUBLIC_BASE_URL=")) {
                envText = envText.replace(
                    /PUBLIC_BASE_URL=.*/,
                    `PUBLIC_BASE_URL=${url}`
                );
            } else {
                envText += `\nPUBLIC_BASE_URL=${url}\n`;
            }
        } else {
            envText = `PUBLIC_BASE_URL=${url}\n`;
        }

        fs.writeFileSync(envFile, envText);

        console.log(`
-----------------------------------------------------
✔ .env updated with new PUBLIC_BASE_URL
✔ Backend auto-detected the change (no restart needed)

PUBLIC_BASE_URL=${url}

Your backend is NOW using the correct webhook URL.
-----------------------------------------------------
`);
    }
});

/* ---------------------------------------------
   Propagate stderr cleanly
--------------------------------------------- */
child.stderr.on("data", (data) => {
    process.stderr.write("[cloudflared] " + data.toString());
});
