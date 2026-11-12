// `.if3` hook values: `script`, `script(args)` or `script(args){t1, t2}` (ares-compiler src/hook.rs
// splits off the trigger list; the call is a RuneScript expression, so commas inside "strings" do not split).

export interface Hook {
  script: string;
  args: string[];
  triggers: string[];
}

/** Top-level comma split outside "…" strings and (…), each part trimmed; "" gives []. */
function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted && c === "\\") {
      cur += c + (s[++i] ?? "");
      continue;
    }
    if (c === '"') quoted = !quoted;
    else if (!quoted && c === "(") depth++;
    else if (!quoted && c === ")") depth--;
    else if (!quoted && depth === 0 && c === ",") {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim() !== "" || out.length) out.push(cur.trim());
  return out;
}

export function parseHook(value: string): Hook {
  let call = value.trim();
  let triggers: string[] = [];
  if (call.endsWith("}") && call.includes("{")) {
    const at = call.lastIndexOf("{");
    triggers = splitArgs(call.slice(at + 1, -1));
    call = call.slice(0, at).trim();
  }
  const open = call.indexOf("(");
  if (open === -1 || !call.endsWith(")")) return { script: call, args: [], triggers };
  return { script: call.slice(0, open).trim(), args: splitArgs(call.slice(open + 1, -1)), triggers };
}

export function formatHook(h: Hook): string {
  const call = h.args.length ? `${h.script}(${h.args.join(", ")})` : h.script;
  return h.triggers.length ? `${call}{${h.triggers.join(", ")}}` : call;
}
