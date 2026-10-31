import { readFile } from "node:fs/promises";

const policyPath = ".trivyignore.yaml";
const policy = await readFile(policyPath, "utf8");
const lines = policy.split(/\r?\n/);
const currentOwner = "rakgithub";
const today = new Date();
today.setUTCHours(0, 0, 0, 0);
const maxExpiry = new Date(today);
maxExpiry.setUTCDate(maxExpiry.getUTCDate() + 90);

const entries = [];
let current = null;
for (const line of lines) {
  if (/^\s{2}-\s+id:\s*\S+/.test(line)) {
    if (current) entries.push(current);
    current = [line];
  } else if (current && (/^\s{4}\S/.test(line) || line.trim() === "")) {
    current.push(line);
  } else if (current) {
    entries.push(current);
    current = null;
  }
}
if (current) entries.push(current);

for (const entryLines of entries) {
  const entry = entryLines.join("\n");
  const id = entry.match(/^\s{2}-\s+id:\s*([^\s#]+)/m)?.[1];
  const statement = entry.match(/^\s{4}statement:\s*["']?([^\n"']+)/m)?.[1]?.trim();
  const expiry = entry.match(/^\s{4}expired_at:\s*["']?(\d{4}-\d{2}-\d{2})/m)?.[1];

  if (!id || !statement || !statement.includes(`owner=@${currentOwner}`) || !/reason=\S/.test(statement)) {
    throw new Error(`${policyPath}: each exception needs an id and a statement with owner=@${currentOwner} and reason=...`);
  }
  if (!expiry || !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) {
    throw new Error(`${policyPath}: ${id} needs an expired_at date in YYYY-MM-DD format`);
  }

  const expiryDate = new Date(`${expiry}T00:00:00.000Z`);
  if (
    Number.isNaN(expiryDate.valueOf()) ||
    expiryDate.toISOString().slice(0, 10) !== expiry ||
    expiryDate <= today ||
    expiryDate > maxExpiry
  ) {
    throw new Error(`${policyPath}: ${id} must expire within the next 90 days`);
  }
}

