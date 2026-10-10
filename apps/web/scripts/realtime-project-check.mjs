// R-5 kiểm tay: hai socket (default và project khác) nối hub-api; bắn webhook vào source default → chỉ socket
// default nhận event.received. node apps/web/scripts/realtime-project-check.mjs <projectId> <bắn-thử.mjs>
// Env: HUB (http://localhost:4100), ADMIN_PASSWORD.
import { spawnSync } from "node:child_process";

import { io } from "socket.io-client";

const HUB = process.env.HUB ?? "http://localhost:4100";
const [projectId, fireScript] = process.argv.slice(2);
const { accessToken: token } = await fetch(`${HUB}/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "admin", password: process.env.ADMIN_PASSWORD ?? "admin123" }),
}).then((r) => r.json());

const open = (auth) =>
  new Promise((resolve) => {
    const s = io(HUB, { transports: ["websocket"], auth, reconnection: false });
    const got = [];
    s.on("event.received", (n) => got.push(n.tenantId));
    s.on("connect", () => resolve({ s, got, err: null }));
    s.on("connect_error", (e) => resolve({ s, got, err: e.message }));
  });

const def = await open({ token });
const proj = await open({ token, projectId });
const bad = await open({ token, projectId: "00000000-0000-4000-8000-0000000000ff" });
console.log("connect default:", def.err ?? "ok", "| project:", proj.err ?? "ok", "| project lạ:", bad.err ?? "ok");
if (fireScript) spawnSync(process.execPath, [fireScript, "sepay"], { stdio: "inherit", env: process.env });
await new Promise((r) => setTimeout(r, 4000));
console.log("event.received default:", def.got.length, def.got[0] ?? "", "| project:", proj.got.length);
for (const x of [def, proj, bad]) x.s.close();
