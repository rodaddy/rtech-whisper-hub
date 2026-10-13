import pino from "pino";

const USAGE =
  "usage: keys mint --name <name> [--owner <owner>] | keys list | keys revoke <id-or-prefix>\n";
const DEFAULT_HUB_URL = "http://localhost:8096";
const logger = pino({ level: process.env.LOG_LEVEL || "info" });

interface DeviceRow {
  id: string;
  name: string;
  owner_id: string;
  prefix: string;
  created_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function usage(): never {
  process.stderr.write(USAGE);
  process.exit(2);
}

/** Parse mint args: --name <n> and optional --owner <o>, in either order. Null on any other shape. */
function mintArgs(args: string[]): { name: string; owner?: string } | null {
  if (args.length !== 2 && args.length !== 4) return null;
  const seen: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag !== "--name" && flag !== "--owner") return null;
    if (flag in seen || value.trim() === "") return null;
    seen[flag] = value;
  }
  if (seen["--name"] === undefined) return null;
  return seen["--owner"] === undefined
    ? { name: seen["--name"] }
    : { name: seen["--name"], owner: seen["--owner"] };
}

/** HUB_ADMIN_TOKEN from the environment; the CLI refuses to run without it. */
function adminToken(): string {
  const fromEnv = process.env.HUB_ADMIN_TOKEN;
  if (fromEnv) return fromEnv;
  process.stderr.write("keys: set HUB_ADMIN_TOKEN to the hub's admin token\n");
  process.exit(2);
}

/** Call an admin route. Returns the parsed body, or null after reporting a non-2xx to stderr. */
async function call(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<unknown> {
  const base = (process.env.HUB_URL || DEFAULT_HUB_URL).replace(/\/+$/, "");
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${adminToken()}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    const message =
      (parsed as { error?: { message?: string } } | null)?.error?.message ??
      (text.trim() || res.statusText);
    process.stderr.write(`${res.status} ${message}\n`);
    return null;
  }
  return parsed;
}

async function main(argv: string[]): Promise<number> {
  const [group, cmd, ...rest] = argv;
  if (group !== "keys") usage();

  const mint = cmd === "mint" ? mintArgs(rest) : null;
  if (mint) {
    const res = (await call("POST", "/admin/devices", mint)) as {
      device: { id: string; name: string; owner_id: string; prefix: string };
      key: string;
    } | null;
    if (!res) return 1;
    out(`id:     ${res.device.id}`);
    out(`name:   ${res.device.name}`);
    out(`owner:  ${res.device.owner_id}`);
    out(`prefix: ${res.device.prefix}`);
    out(`key:    ${res.key}`);
    out("This key is shown once and is not stored. Save it now.");
    return 0;
  }
  if (cmd === "list" && rest.length === 0) {
    const res = (await call("GET", "/admin/devices")) as {
      devices: DeviceRow[];
    } | null;
    if (!res) return 1;
    out(
      ["id", "name", "owner", "prefix", "created", "last_used", "revoked"].join(
        "\t",
      ),
    );
    for (const d of res.devices) {
      out(
        [
          d.id,
          d.name,
          d.owner_id,
          d.prefix,
          d.created_at ?? "-",
          d.last_used_at ?? "-",
          d.revoked_at ?? "-",
        ].join("\t"),
      );
    }
    return 0;
  }
  if (cmd === "revoke" && rest.length === 1) {
    const target = rest[0];
    const res = await call(
      "POST",
      `/admin/devices/${encodeURIComponent(target)}/revoke`,
    );
    if (!res) return 1;
    out(`revoked: ${target}`);
    return 0;
  }
  usage();
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    logger.error(
      { err_message: err instanceof Error ? err.message : "unknown error" },
      "keys command failed",
    );
    process.exit(1);
  },
);
