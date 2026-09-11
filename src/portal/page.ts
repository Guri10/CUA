/**
 * The sign-on portal's one page.
 *
 * A person opens it once at the start of a session, picks which Operator to act
 * as and at which branch, and types the password. The page posts those to
 * `/signon`; the server validates them against MERIDIAN and, only on success,
 * puts the password in the in-memory store the runs read from (#39 B, #42, #44).
 *
 * The password is a `type="password"` field and is sent in the POST body, never
 * placed in the URL or a link — so it does not land in browser history, a
 * bookmark, or a server access log the way a query string would. The page shows
 * "Signed on as …" from the server's reply; it never echoes the password back.
 */
export function signOnPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>MERIDIAN sign-on</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 30rem; margin: 3rem auto; padding: 0 1rem; }
  h1 { font-size: 1.3rem; }
  label { display: block; margin: 0.75rem 0 0.25rem; font-weight: 600; }
  input { width: 100%; padding: 0.5rem; font-size: 1rem; box-sizing: border-box; }
  button { margin-top: 1rem; padding: 0.5rem 1rem; font-size: 1rem; cursor: pointer; }
  #result { margin-top: 1.25rem; padding: 0.75rem; border-radius: 4px; }
  #result.ok { background: #e6f4ea; }
  #result.err { background: #fce8e6; }
  .hint { color: #555; font-weight: 400; font-size: 0.85rem; }
</style>
</head>
<body>
<h1>MERIDIAN sign-on</h1>
<p class="hint">Sign on once for this session. The password is held only in the
server's memory and is never written to disk, evidence, or logs.</p>
<form id="form" autocomplete="off">
  <label for="operator">Operator ID <span class="hint">(e.g. teller1 or super1)</span></label>
  <input id="operator" name="operator" required />
  <label for="branch">Branch <span class="hint">(the whole label, e.g. "MAIN-001 - Main Office")</span></label>
  <input id="branch" name="branch" required />
  <label for="password">Password</label>
  <input id="password" name="password" type="password" required />
  <button type="submit">Sign on</button>
  <button type="button" id="signoff">Sign off</button>
</form>
<p class="hint">This installation acts as the first operator you sign on as until it
restarts. Sign off, or leave it idle, to lock it again.</p>
<div id="result" hidden></div>
<script>
  const form = document.getElementById("form");
  const result = document.getElementById("result");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    result.hidden = false;
    result.className = "";
    result.textContent = "Signing on…";
    const payload = {
      operator: form.operator.value,
      branch: form.branch.value,
      password: form.password.value,
    };
    // The password leaves the field the moment the request is built, and the
    // field is cleared straight after so it does not linger in the DOM.
    form.password.value = "";
    try {
      const response = await fetch("/signon", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await response.json();
      if (response.ok) {
        result.className = "ok";
        result.textContent = body.role
          ? "Signed on as " + body.operator + " (" + body.role + ")."
          : "Signed on as " + body.operator + ".";
      } else {
        result.className = "err";
        result.textContent = body.error || "Sign-on failed.";
      }
    } catch (error) {
      result.className = "err";
      result.textContent = "Could not reach the portal: " + error;
    }
  });
  document.getElementById("signoff").addEventListener("click", async () => {
    result.hidden = false;
    result.className = "";
    result.textContent = "Signing off…";
    try {
      const response = await fetch("/signoff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      result.className = response.ok ? "ok" : "err";
      result.textContent = response.ok ? "Signed off. The console is locked again." : "Sign-off failed.";
    } catch (error) {
      result.className = "err";
      result.textContent = "Could not reach the portal: " + error;
    }
  });
</script>
</body>
</html>
`;
}
