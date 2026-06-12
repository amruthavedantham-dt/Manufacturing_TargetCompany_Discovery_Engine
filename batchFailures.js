// ============================================================
// batchFailures.js
// Accumulates technical errors during a pipeline run in Script
// Properties and renders them as a popup dialog on demand.
//
// Public surface:
//   batchFailuresInit_(runId)                     call at run start
//   batchFailuresPush_(company, web, stage, msg)  called by EventLog.error()
//   showBatchFailures()                           menu item handler
//   onOpen()                                      creates Pipeline menu
// ============================================================

var BATCH_FAILURES_KEY = 'BATCH_FAILURES';

// ── Called once at the start of each pipeline run ────────────
// Replaces any data from the previous run.
function batchFailuresInit_(runId) {
  try {
    PropertiesService.getScriptProperties().setProperty(
      BATCH_FAILURES_KEY,
      JSON.stringify({
        runId:     runId || '',
        startedAt: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'HH:mm:ss'),
        entries:   [],
      })
    );
  } catch (e) {
    Logger.log('[batchFailuresInit ERROR] ' + e.message);
  }
}

// ── Called by EventLog.error() for every company-level error ─
// Skips system-level errors where company is empty.
// Capped at 200 entries to stay under the 9 KB property limit.
function batchFailuresPush_(company, website, stage, message) {
  if (!company) return;
  try {
    var props = PropertiesService.getScriptProperties();
    var raw   = props.getProperty(BATCH_FAILURES_KEY);
    var data  = raw ? JSON.parse(raw) : { runId: '', startedAt: '', entries: [] };

    if (data.entries.length >= 200) return;

    data.entries.push({
      company: String(company  || ''),
      website: String(website  || '—'),
      stage:   String(stage    || ''),
      message: String(message  || '').slice(0, 200),
      time:    Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'HH:mm:ss'),
    });

    props.setProperty(BATCH_FAILURES_KEY, JSON.stringify(data));
  } catch (e) {
    Logger.log('[batchFailuresPush ERROR] ' + e.message);
  }
}

// ── Reads Script Properties and renders an HTML modal dialog ─
function showBatchFailures() {
  var raw  = PropertiesService.getScriptProperties().getProperty(BATCH_FAILURES_KEY);
  var data = raw ? JSON.parse(raw) : null;

  var html;

  if (!data) {
    html = '<p style="font-family:Arial;color:#555;padding:16px">'
         + 'No batch run recorded yet. Run <b>runInitialPipeline()</b> first.</p>';
  } else if (!data.entries || data.entries.length === 0) {
    html = '<div style="font-family:Arial;padding:20px;text-align:center">'
         + '<p style="font-size:14px;color:#333"><b>Run:</b> ' + data.runId
         + ' &nbsp;|&nbsp; <b>Started:</b> ' + data.startedAt + '</p>'
         + '<p style="font-size:22px;color:#34a853">&#10003; No failures in this run</p>'
         + '</div>';
  } else {
    var rows = data.entries.map(function(e) {
      return '<tr>'
        + '<td style="padding:6px 10px;border-bottom:1px solid #e0e0e0">' + escapeHtml_(e.company) + '</td>'
        + '<td style="padding:6px 10px;border-bottom:1px solid #e0e0e0;color:#555">' + escapeHtml_(e.website) + '</td>'
        + '<td style="padding:6px 10px;border-bottom:1px solid #e0e0e0;color:#555">' + escapeHtml_(e.stage) + '</td>'
        + '<td style="padding:6px 10px;border-bottom:1px solid #e0e0e0;color:#c0392b">' + escapeHtml_(e.message) + '</td>'
        + '<td style="padding:6px 10px;border-bottom:1px solid #e0e0e0;color:#888;white-space:nowrap">' + e.time + '</td>'
        + '</tr>';
    }).join('');

    html = '<div style="font-family:Arial;font-size:13px">'
         + '<div style="background:#f8f9fa;padding:12px 16px;border-bottom:1px solid #ddd">'
         + '<b>Run:</b> ' + data.runId + ' &nbsp;|&nbsp; <b>Started:</b> ' + data.startedAt
         + ' &nbsp;|&nbsp; <b style="color:#c0392b">' + data.entries.length + ' failure'
         + (data.entries.length !== 1 ? 's' : '') + '</b>'
         + (data.entries.length >= 200 ? ' <span style="color:#888">(capped at 200)</span>' : '')
         + '</div>'
         + '<div style="overflow-y:auto;max-height:360px">'
         + '<table style="width:100%;border-collapse:collapse">'
         + '<thead><tr style="background:#f1f3f4">'
         + '<th style="padding:8px 10px;text-align:left;font-weight:600">Company</th>'
         + '<th style="padding:8px 10px;text-align:left;font-weight:600">Website</th>'
         + '<th style="padding:8px 10px;text-align:left;font-weight:600">Stage</th>'
         + '<th style="padding:8px 10px;text-align:left;font-weight:600">Error</th>'
         + '<th style="padding:8px 10px;text-align:left;font-weight:600">Time</th>'
         + '</tr></thead>'
         + '<tbody>' + rows + '</tbody>'
         + '</table></div></div>';
  }

  var output = HtmlService.createHtmlOutput(html)
    .setWidth(820)
    .setHeight(460);

  SpreadsheetApp.getUi().showModalDialog(output, 'Batch Failures');
}

// ── Escapes HTML special characters for safe inline rendering ─
function escapeHtml_(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// onOpen() lives in Menu.js — all menu items are managed there.
