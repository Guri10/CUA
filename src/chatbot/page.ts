/**
 * The chatbot's page: one self-contained HTML document, server-rendered once and
 * handed to the browser, that talks to `POST /chat` on this same origin. It is
 * the human-facing half of the chatbot — the CLI's other caller — so anyone who
 * can reach the port uses it in a browser, no account and no model key of their
 * own (the operator's `CHATBOT_API_KEY` stays server-side, ADR 0006).
 *
 * It renders the structured chain the endpoint returns — each Capability it
 * invoked and how that ended — rather than only the plain-language answer, so a
 * watcher sees the same outcomes a Replay reports: a success, a Business Outcome,
 * an escalation, a Hard Failure. It enforces nothing: the catalog is the only
 * boundary (ADR 0007), and this page is a caller of it.
 *
 * Two run choices ride the request as booleans — preview a mutating step without
 * running it, or hold it for an explicit confirm — applied by the chatbot, not
 * here. "Show the browser" is deliberately not a per-request toggle: the browser
 * runs on the operator's machine, so it is the operator's `serve --headed`, noted
 * rather than offered to every viewer.
 */

/** The whole page. `dashboardUrl` links a run to the read-only viewer, when known. */
export function chatPage(dashboardUrl?: string): string {
  const dash = dashboardUrl ?? "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MERIDIAN chatbot</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="brand"><h1>MERIDIAN</h1><span class="tag">Chatbot</span></div>
    <p class="sub">Ask in plain language. It maps your request to approved capabilities, chains them, and shows the structured result. The catalog decides risk and approval; this page only asks.</p>
  </header>
  <div class="log" id="log"></div>
  <div class="prompts" id="prompts">
    <button data-p="What are member 100234's balances?">balances for 100234</button>
    <button data-p="Transfer $1 between 100234's shares">transfer $1</button>
    <button data-p="Place a fraud hold on 100234's main share">place a hold</button>
  </div>
  <div class="composer">
    <div class="toggles">
      <label class="tg"><input type="checkbox" id="tg-preview"><span class="sw"></span>Preview only (don't post)</label>
      <label class="tg"><input type="checkbox" id="tg-confirm"><span class="sw"></span>Confirm before posting</label>
      <label class="tg locked" title="A Secret is never written; Sensitive data is always masked in saved evidence. Off is disabled here."><input type="checkbox" checked disabled><span class="sw"></span>Mask sensitive data in evidence <span class="lock">&#128274;</span></label>
    </div>
    <div class="row">
      <input type="text" id="msg" placeholder="e.g. transfer $1 between member 100234's shares" autocomplete="off">
      <button class="send" id="send">Send</button>
    </div>
    <p class="hint">Toggles apply to the next run and act on a mutating step only. To watch the browser drive the screen, the operator runs <code>serve --headed</code>.</p>
  </div>
</div>
<div class="toast" id="toast"></div>
<script>${SCRIPT.replace("__DASH__", JSON.stringify(dash))}</script>
</body>
</html>
`;
}

const STYLE = `
:root {
  color-scheme: light dark;
  --ink:#1a1a1a; --muted:#6b7280; --line:#e5e7eb; --bg:#fafafa; --card:#fff;
  --accent:#1e40af; --accent-ink:#fff;
  --ok-bg:#d1fae5; --ok-ink:#065f46; --warn-bg:#fef3c7; --warn-ink:#92400e;
  --info-bg:#dbeafe; --info-ink:#1e40af; --err-bg:#fee2e2; --err-ink:#991b1b;
  --user-bg:#eef2ff; --user-ink:#1a1a1a;
  --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --ink:#e5e7eb; --muted:#9ca3af; --line:#2a2a2a; --bg:#111; --card:#1a1a1a;
  --accent:#3b6fe0; --ok-bg:#06341f; --ok-ink:#6ee7b7; --warn-bg:#3a2e05; --warn-ink:#fcd34d;
  --info-bg:#10233f; --info-ink:#93c5fd; --err-bg:#3a0f0f; --err-ink:#fca5a5; --user-bg:#1c2438; --user-ink:#e5e7eb;
} }
:root[data-theme="dark"] {
  --ink:#e5e7eb; --muted:#9ca3af; --line:#2a2a2a; --bg:#111; --card:#1a1a1a;
  --accent:#3b6fe0; --ok-bg:#06341f; --ok-ink:#6ee7b7; --warn-bg:#3a2e05; --warn-ink:#fcd34d;
  --info-bg:#10233f; --info-ink:#93c5fd; --err-bg:#3a0f0f; --err-ink:#fca5a5; --user-bg:#1c2438; --user-ink:#e5e7eb;
}
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
.wrap { max-width:760px; margin:0 auto; min-height:100vh; display:flex; flex-direction:column; }
header { padding:20px 20px 8px; }
.brand { display:flex; align-items:baseline; gap:10px; }
h1 { margin:0; font-size:20px; letter-spacing:.04em; }
.tag { font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); border:1px solid var(--line); padding:1px 7px; border-radius:10px; }
.sub { margin:4px 0 0; color:var(--muted); font-size:12.5px; }
.log { flex:1; padding:8px 20px 12px; display:flex; flex-direction:column; gap:14px; overflow-y:auto; }
.turn { display:flex; flex-direction:column; gap:6px; }
.turn.user { align-items:flex-end; }
.bubble { max-width:82%; padding:9px 13px; border-radius:14px; }
.turn.user .bubble { background:var(--user-bg); color:var(--user-ink); border-bottom-right-radius:4px; }
.turn.bot .bubble { background:var(--card); border:1px solid var(--line); border-bottom-left-radius:4px; max-width:100%; }
.trace { margin-top:8px; border-top:1px dashed var(--line); padding-top:8px; display:flex; flex-direction:column; gap:8px; }
.chain { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
.chip { display:inline-block; padding:1px 8px; border-radius:10px; background:var(--line); font-size:12px; }
.chip.cap { font-family:var(--mono); }
.arrow { color:var(--muted); }
.badge { padding:2px 9px; border-radius:10px; font-size:11.5px; font-weight:600; }
.badge.ok { background:var(--ok-bg); color:var(--ok-ink); }
.badge.biz { background:var(--info-bg); color:var(--info-ink); }
.badge.esc { background:var(--warn-bg); color:var(--warn-ink); }
.badge.fail { background:var(--err-bg); color:var(--err-ink); }
.badge.prev { background:var(--line); color:var(--muted); }
.result { background:color-mix(in srgb, var(--card) 92%, var(--line)); border:1px solid var(--line); border-radius:8px; padding:9px 11px; }
.kv { display:grid; grid-template-columns:150px 1fr; gap:4px 10px; margin:0; }
.kv dt { color:var(--muted); font-size:12px; }
.kv dd { margin:0; font-family:var(--mono); font-size:12.5px; word-break:break-word; }
table.sh { width:100%; border-collapse:collapse; font-size:12.5px; }
table.sh th { text-align:left; color:var(--muted); font-weight:600; padding:3px 8px; font-size:11px; text-transform:uppercase; letter-spacing:.04em; }
table.sh td { padding:4px 8px; border-top:1px solid var(--line); font-family:var(--mono); }
.st-open { color:var(--ok-ink); } .st-hold { color:var(--warn-ink); }
.note { color:var(--muted); font-size:11.5px; margin-top:6px; }
.run-actions { margin-top:2px; }
.link { color:var(--accent); }
.confirm { display:flex; gap:8px; align-items:center; background:var(--warn-bg); color:var(--warn-ink); padding:8px 11px; border-radius:8px; font-size:12.5px; flex-wrap:wrap; }
.confirm button { background:var(--warn-ink); color:var(--warn-bg); border:none; padding:4px 11px; border-radius:7px; font-weight:600; cursor:pointer; }
.prompts { display:flex; gap:7px; flex-wrap:wrap; padding:0 20px 4px; }
.prompts button { background:var(--card); border:1px solid var(--line); color:var(--ink); padding:5px 10px; border-radius:14px; font-size:12px; cursor:pointer; }
.prompts button:hover { border-color:var(--accent); }
.composer { position:sticky; bottom:0; background:var(--bg); border-top:1px solid var(--line); padding:10px 20px 16px; }
.toggles { display:flex; gap:14px; flex-wrap:wrap; margin-bottom:9px; align-items:center; }
.tg { display:inline-flex; align-items:center; gap:7px; font-size:12.5px; user-select:none; cursor:pointer; }
.tg input { position:absolute; opacity:0; width:0; height:0; }
.sw { width:34px; height:19px; border-radius:19px; background:var(--line); position:relative; transition:background .15s; flex:none; }
.sw::after { content:""; position:absolute; top:2px; left:2px; width:15px; height:15px; border-radius:50%; background:#fff; transition:transform .15s; box-shadow:0 1px 2px rgba(0,0,0,.3); }
.tg input:checked + .sw { background:var(--accent); }
.tg input:checked + .sw::after { transform:translateX(15px); }
.tg.locked { color:var(--muted); cursor:default; }
.tg.locked .sw { background:var(--ok-ink); opacity:.55; }
.lock { font-size:11px; }
.row { display:flex; gap:9px; }
.row input[type=text] { flex:1; padding:10px 13px; border:1px solid var(--line); border-radius:10px; background:var(--card); color:var(--ink); font:inherit; }
.row input[type=text]:focus { outline:none; border-color:var(--accent); }
.send { background:var(--accent); color:var(--accent-ink); border:none; padding:0 18px; border-radius:10px; font-weight:600; cursor:pointer; }
.send:disabled { opacity:.5; cursor:default; }
.hint { color:var(--muted); font-size:11px; margin-top:7px; }
.hint code { font-family:var(--mono); }
.toast { position:fixed; bottom:84px; left:50%; transform:translateX(-50%); background:var(--ink); color:var(--bg); padding:7px 14px; border-radius:8px; font-size:12.5px; opacity:0; transition:opacity .2s; pointer-events:none; }
.toast.show { opacity:.95; }
`;

// Kept a string so the module has no client bundle step: it ships as-is. `__DASH__`
// is replaced with the dashboard URL JSON at render time.
const SCRIPT = `
const DASH = __DASH__;
const log = document.getElementById("log");
const input = document.getElementById("msg");
const sendBtn = document.getElementById("send");
const toastEl = document.getElementById("toast");
const preview = () => document.getElementById("tg-preview").checked;
const confirmTg = () => document.getElementById("tg-confirm").checked;

function esc(s){ return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function el(html){ const d=document.createElement("div"); d.innerHTML=html.trim(); return d.firstElementChild; }
function scroll(){ log.scrollTop = log.scrollHeight; }
function toast(t){ toastEl.textContent=t; toastEl.classList.add("show"); setTimeout(()=>toastEl.classList.remove("show"),1600); }

function addUser(text){ log.appendChild(el('<div class="turn user"><div class="bubble">'+esc(text)+'</div></div>')); scroll(); }
// Returns the bubble itself (the turn's only child) so callers render into it
// without a DOM query — ADR 0001 bans selector queries across the codebase.
function addBot(innerHtml){ const t=el('<div class="turn bot"><div class="bubble">'+innerHtml+'</div></div>'); log.appendChild(t); scroll(); return t.firstElementChild; }

function kv(pairs){ return '<dl class="kv">'+pairs.map(([k,v])=>'<dt>'+esc(k)+'</dt><dd>'+esc(v)+'</dd>').join("")+'</dl>'; }

function sharesTable(shares){
  const rows = shares.map(s => '<tr><td>'+esc(s.shareId)+'</td><td>'+esc(s.type)+'</td><td>'+esc(s.balance)+'</td><td class="st-'+(String(s.status).toLowerCase().indexOf("hold")>=0?"hold":"open")+'">'+esc(s.status)+'</td></tr>').join("");
  return '<table class="sh"><thead><tr><th>Share</th><th>Type</th><th>Balance</th><th>Status</th></tr></thead><tbody>'+rows+'</tbody></table><div class="note">Returned to you in full; saved evidence records these masked.</div>';
}

function renderOutputs(outputs){
  if (!outputs || typeof outputs !== "object") return "";
  if (Array.isArray(outputs.shares)) return sharesTable(outputs.shares);
  const pairs = Object.entries(outputs).map(([k,v]) => [k, typeof v==="object"?JSON.stringify(v):String(v)]);
  return pairs.length ? kv(pairs) : "";
}

// One outcome -> a badge class/label and a body. Mirrors the catalog's union.
function renderOutcome(o){
  switch(o.kind){
    case "success": return { badge:["ok","Success"], body:'<div class="result">'+renderOutputs(o.outputs)+'</div>' };
    case "business-outcome": return { badge:["biz","Business outcome"], body:'<div class="result">'+kv([["Outcome",o.name],["Step",o.step]])+'</div>' };
    case "hard-failure": return { badge:["fail","Failed"], body:'<div class="result">'+kv([["Step",o.step],["Expected",o.expected||""],["Observed",o.observed||""]])+'</div>' };
    case "escalated": return { badge:["esc","Escalated"], body:'<div class="result">'+kv([["Where",o.context&&o.context.step||""],["Reason",o.context&&o.context.reason||""]])+'</div><div class="note">No browser opened and no evidence run was written &mdash; the gate stops it before a run exists.</div>' };
    case "rejected": return { badge:["esc","Rejected"], body:'<div class="result">'+kv([["Status",String(o.status)],["Why",o.error||""]])+'</div>' };
    case "interrupted": return { badge:["esc","Interrupted"], body:'<div class="note">The run was interrupted before it reached an ending.</div>' };
    default: return { badge:["esc","Unknown"], body:"" };
  }
}

function chainChips(steps){
  return steps.map(s => '<span class="chip cap">'+esc(s.invocation.ref)+'</span>').join('<span class="arrow">&rarr;</span>');
}

function dashLink(){
  return DASH ? '<div class="run-actions"><a class="link" href="'+esc(DASH)+'" target="_blank" rel="noopener">view runs in the dashboard &rarr;</a></div>' : "";
}

// Render one server reply into the last bot bubble.
function renderReply(bubble, data, lastMessage){
  let html = '<div>'+esc(data.answer)+'</div>';
  const steps = data.steps || [];
  if (steps.length || data.pending){
    html += '<div class="trace">';
    const chips = steps.length ? chainChips(steps) : (data.pending ? '<span class="chip cap">'+esc(data.pending.ref)+'</span>' : "");
    let badge = "";
    if (data.pending){ badge = data.pending.reason==="preview" ? '<span class="badge prev">Preview</span>' : '<span class="badge prev">Awaiting confirm</span>'; }
    else if (steps.length){ const last = renderOutcome(steps[steps.length-1].outcome); badge = '<span class="badge '+last.badge[0]+'">'+last.badge[1]+'</span>'; }
    html += '<div class="chain">'+chips+badge+'</div>';
    for (const s of steps){ html += renderOutcome(s.outcome).body; }
    if (data.pending && data.pending.reason==="confirm"){
      html += '<div class="confirm">This posts a real transaction. <button class="confirm-btn">Confirm &amp; post</button></div>';
    }
    if (steps.some(s => s.outcome.kind==="success")) html += dashLink();
    html += '</div>';
  }
  bubble.innerHTML = html;
  const btn = bubble.getElementsByClassName("confirm-btn")[0];
  // Send back the exact invocation the caller was shown, so what posts is what
  // was confirmed rather than a re-derived one.
  if (btn) btn.addEventListener("click", () => { btn.disabled = true; send(lastMessage, { proceed:true, invocation: data.pending && data.pending.invocation }); });
  scroll();
}

async function send(text, extra){
  const v = (text != null ? text : input.value).trim();
  if (!v) return;
  if (extra == null) addUser(v);
  if (text == null) input.value = "";
  sendBtn.disabled = true;
  const bubble = addBot('<div class="muted">&hellip;</div>');
  try {
    const body = { message:v, preview:preview(), confirm:confirmTg(), proceed:(extra&&extra.proceed)===true };
    if (extra && extra.invocation) body.invocation = extra.invocation;
    const res = await fetch("/chat", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok && !data.steps){ bubble.innerHTML = '<div>'+esc(data.error || ("Request failed ("+res.status+")."))+'</div>'; }
    else renderReply(bubble, data, v);
  } catch (e) {
    bubble.innerHTML = '<div>Couldn\\'t reach the chatbot. Is <code>serve</code> running? ('+esc(String(e))+')</div>';
  } finally {
    sendBtn.disabled = false;
  }
}

sendBtn.addEventListener("click", () => send());
input.addEventListener("keydown", e => { if (e.key==="Enter") send(); });
document.getElementById("prompts").addEventListener("click", e => { const b=e.target.closest("button"); if (b) send(b.dataset.p); });
addBot('<div>Hi &mdash; I drive the MERIDIAN capabilities for you. Ask about a member&rsquo;s balances, a transfer, or a hold. Toggles below change how the next run behaves.</div>');
`;
