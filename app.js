const $ = id => document.getElementById(id);
const form = $("reminder-form");
const field = name => form.elements.namedItem(name);
const { supabaseUrl, publishableKey } = window.CALIBRATION_CONFIG ?? {};
const base = supabaseUrl?.replace(/\/+$/, "");
const sessionKey = `calibration-session:${base}`;
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const dateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium", timeStyle: "short", timeZone,
});
const day = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" });
let token = sessionStorage.getItem(sessionKey);
let gmailSender = null;
let previewInput;
let listVersion = 0;

function notice(message, error = false) {
  $("notice").hidden = !message;
  $("notice").textContent = message;
  $("notice").classList.toggle("error", error);
}

function showSession(nextToken) {
  token = nextToken;
  if (token) sessionStorage.setItem(sessionKey, token);
  else sessionStorage.removeItem(sessionKey);
  $("login").hidden = Boolean(token);
  $("workspace").hidden = !token;
  $("sign-out").hidden = !token;
  if (!token) {
    listVersion++;
    renderGmail(null, "Checking Gmail connection…");
    form.reset();
    updateMode();
    renderJobs([]);
  }
}

async function call(action, fields = {}, endpoint = "reminders") {
  const currentToken = token;
  const response = await fetch(`${base}/functions/v1/${endpoint}`, {
    method: "POST",
    headers: {
      apikey: publishableKey,
      authorization: `Bearer ${currentToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ action, ...fields }),
  });
  if (currentToken !== token) throw new Error("The sign-in session changed.");
  const result = await response.json();
  if (response.status === 401) showSession(null);
  if (!response.ok) throw new Error(result.error || "The request could not be completed.");
  return result;
}

function renderGmail(email, message) {
  if (gmailSender !== email) hidePreview();
  gmailSender = email;
  $("gmail-status").textContent = message ?? (email ? `Sending as ${email}` : "Connect Gmail to create a reminder.");
  $("gmail-connect").hidden = Boolean(message);
  $("gmail-connect").textContent = email ? "Reconnect Gmail" : "Connect Gmail";
  $("gmail-disconnect").hidden = !email;
  $("preview-button").disabled = !email;
}

async function refreshGmail() {
  try {
    const result = await call("status", {}, "gmail-connect");
    renderGmail(result.email);
  } catch (error) {
    if (token) renderGmail(null, `${error.message} Use Refresh to try again.`);
  }
}

$("gmail-connect").addEventListener("click", event => run(event.currentTarget, async () => {
  const result = await call("start", {}, "gmail-connect");
  window.location.assign(result.url);
}));
$("gmail-disconnect").addEventListener("click", event => {
  if (!window.confirm("Disconnect Gmail? Pending reminders using this account need it reconnected before their send time.")) return;
  run(event.currentTarget, async () => {
    await call("disconnect", {}, "gmail-connect");
    renderGmail(null);
    notice("Gmail disconnected.");
  });
});

async function run(button, operation) {
  button.disabled = true;
  notice("");
  try {
    await operation();
  } catch (error) {
    notice(error.message, true);
  } finally {
    button.disabled = false;
  }
}

function hidePreview() {
  previewInput = undefined;
  $("preview").hidden = true;
}

function updateMode() {
  const mode = field("mode").value;
  $("exact-fields").hidden = mode !== "exact";
  $("relative-fields").hidden = mode !== "before";
  $("time-zone").hidden = mode === "manual";
  field("when").disabled = mode !== "exact";
  field("when").required = mode === "exact";
  field("days").disabled = mode !== "before";
  field("clock").disabled = mode !== "before";
  field("days").required = mode === "before";
  field("clock").required = mode === "before";
  hidePreview();
}

function schedule() {
  const mode = field("mode").value;
  if (mode === "manual") return null;
  let wallTime = field("when").value;
  if (mode === "before") {
    const expiry = new Date(`${field("expires_on").value}T00:00:00Z`);
    expiry.setUTCDate(expiry.getUTCDate() - Number(field("days").value));
    wallTime = `${expiry.toISOString().slice(0, 10)}T${field("clock").value}`;
  }
  const instant = new Date(wallTime);
  if (!Number.isFinite(+instant)) throw new Error("Choose a valid date and time.");
  const pad = value => String(value).padStart(2, "0");
  const local = `${instant.getFullYear()}-${pad(instant.getMonth() + 1)}-${pad(instant.getDate())}T${pad(instant.getHours())}:${pad(instant.getMinutes())}`;
  if (local !== wallTime) throw new Error("This time does not exist in your time zone. Choose another time.");
  if (+instant <= Date.now()) throw new Error("Choose a reminder time in the future.");
  return instant.toISOString();
}

function inputs() {
  const values = Object.fromEntries(new FormData(form));
  return {
    component: values.component, calibrated_on: values.calibrated_on,
    expires_on: values.expires_on, recipient: values.recipient, cc: values.cc,
    scheduled_at: schedule(),
  };
}

function showPreview(job) {
  const details = [
    ["From", job.from], ["To", job.recipient], ["CC", job.cc], ["Subject", job.subject],
    ["Send time", job.scheduled_at ? `${dateTime.format(new Date(job.scheduled_at))} · ${timeZone}` : "Manual only"],
  ];
  $("preview-meta").replaceChildren(...details.flatMap(([label, value]) => {
    if (!value) return [];
    const term = document.createElement("dt");
    const description = document.createElement("dd");
    term.textContent = label;
    description.textContent = value;
    return [term, description];
  }));
  $("preview-body").textContent = job.body;
  $("preview").hidden = false;
  $("preview-title").scrollIntoView({ block: "nearest" });
}

function renderJobs(jobs) {
  $("empty").hidden = jobs.length > 0;
  $("waiting-count").textContent = jobs.filter(job => ["pending", "sending"].includes(job.status)).length;
  $("sent-count").textContent = jobs.filter(job => job.status === "sent").length;
  $("failed-count").textContent = jobs.filter(job => job.status === "failed").length;
  $("jobs").replaceChildren(...jobs.map(job => {
    const item = $("job-template").content.firstElementChild.cloneNode(true);
    const within = selector => item.querySelector(selector);
    within("h3").textContent = job.component;
    const badge = within(".badge");
    badge.dataset.state = job.status;
    badge.textContent = {
      pending: job.retry_at ? "Retry queued" : job.scheduled_at ? "Scheduled" : "Ready",
      sent: "Sent", failed: "Failed", canceled: "Canceled", sending: "Sending",
    }[job.status];
    const format = value => dateTime.format(new Date(value));
    within(".job-schedule").textContent = job.sent_at ? `Sent ${format(job.sent_at)}`
      : job.retry_at && job.status === "pending" ? `Retry after ${format(job.retry_at)}`
      : job.scheduled_at ? `Scheduled for ${format(job.scheduled_at)}` : "Manual send only";
    within(".job-dates").textContent =
      `Calibrated ${day.format(new Date(job.calibrated_on))} · Expires ${day.format(new Date(job.expires_on))}`;
    within(".job-to").textContent =
      `${job.gmail_from ? `From ${job.gmail_from} · ` : ""}To ${job.recipient}${job.cc ? ` · CC ${job.cc}` : ""}`;
    within(".job-error").hidden = !job.error;
    within(".job-error").textContent = job.error ?? "";
    const ready = job.status === "pending" && job.attempts === 0;
    within(".job-actions").hidden = !ready;
    within(".send").addEventListener("click", event => {
      const button = event.currentTarget;
      if (!window.confirm(`Send this reminder now to ${job.recipient}${job.cc ? ` (CC ${job.cc})` : ""}?`)) return;
      run(button, async () => {
        const { job: result } = await call("send", { id: job.id });
        if (result.status === "sent") notice("Email accepted by the sending provider.");
        else notice(result.error ?? "Email was not confirmed.", true);
        await refresh();
      });
    });
    within(".cancel").addEventListener("click", event => run(event.currentTarget, async () => {
      await call("cancel", { id: job.id });
      notice("Reminder canceled.");
      await refresh();
    }));
    return item;
  }));
}

async function refresh() {
  const version = ++listVersion;
  const { jobs } = await call("list");
  if (version === listVersion) renderJobs(jobs);
}

$("login-form").addEventListener("submit", event => {
  event.preventDefault();
  const loginForm = event.currentTarget;
  run(event.submitter, async () => {
    const response = await fetch(`${base}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: publishableKey, "content-type": "application/json" },
      body: JSON.stringify(Object.fromEntries(new FormData(loginForm))),
    });
    const result = await response.json();
    if (!response.ok || !result.access_token) {
      throw new Error("Sign-in failed. Check your demo account email and password.");
    }
    loginForm.reset();
    showSession(result.access_token);
    await Promise.all([refresh(), refreshGmail()]);
  });
});

$("sign-out").addEventListener("click", () => {
  showSession(null);
  notice("");
});
$("refresh").addEventListener("click", event =>
  run(event.currentTarget, () => Promise.all([refresh(), refreshGmail()])));
form.addEventListener("input", hidePreview);
field("mode").addEventListener("change", updateMode);
form.addEventListener("submit", event => {
  event.preventDefault();
  run(event.submitter, async () => {
    const snapshot = inputs();
    const { job } = await call("preview", snapshot);
    if (JSON.stringify(inputs()) !== JSON.stringify(snapshot)) {
      throw new Error("The form changed. Preview the updated reminder before saving.");
    }
    previewInput = { ...snapshot, id: crypto.randomUUID(), preview_from: job.from };
    showPreview(job);
  });
});
$("save").addEventListener("click", event => run(event.currentTarget, async () => {
  if (!previewInput) throw new Error("Preview the email before saving.");
  await call("create", previewInput);
  form.reset();
  updateMode();
  notice("Reminder saved.");
  await refresh();
}));

if (!base || !publishableKey) {
  $("setup").hidden = false;
} else {
  $("time-zone").textContent = `Time zone: ${timeZone}`;
  updateMode();
  renderGmail(null, "Checking Gmail connection…");
  showSession(token);
  const url = new URL(window.location.href);
  const result = url.searchParams.get("gmail");
  if (result) {
    url.searchParams.delete("gmail");
    history.replaceState(null, "", url);
    notice(result === "connected" ? "Gmail connected." :
      "Gmail connection was not completed. Try connecting again.", result !== "connected");
  }
  if (token) {
    refreshGmail();
    refresh().catch(error => notice(error.message, true));
  }
  document.addEventListener("visibilitychange", () => {
    if (token && !document.hidden) refresh().catch(error => notice(error.message, true));
  });
}
