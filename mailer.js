const nodemailer = require("nodemailer");

// Create transport from environment variables
const host = process.env.SMTP_HOST;
const port = parseInt(process.env.SMTP_PORT || "1025", 10);
const user = process.env.SMTP_USER;
const pass = process.env.SMTP_PASS;
const fromAddress = process.env.SMTP_FROM || "noreply@plakshabudget.com";
const secure = process.env.SMTP_SECURE === "true";
const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5174";

let transporter = null;
if (host) {
  const transportConfig = {
    host,
    port,
    secure,
  };
  if (user && pass) {
    transportConfig.auth = { user, pass };
  }
  transporter = nodemailer.createTransport(transportConfig);
  console.log(`[Mailer] SMTP configured: host=${host}, port=${port}, secure=${secure}, user=${user ? "configured" : "none"}`);
} else {
  console.log("[Mailer] SMTP_HOST is not set. Mailer running in dry-run mode.");
}

async function sendMail(to, subject, html, text, attachments = []) {
  if (!transporter) {
    console.log(`[Mailer Dry-Run] To: ${to} | Subject: ${subject}`);
    if (text) console.log(`[Mailer Dry-Run] Text: ${text.slice(0, 100)}...`);
    return;
  }

  try {
    const mailOptions = {
      from: fromAddress,
      to,
      subject,
      text,
      html,
    };
    if (attachments && attachments.length > 0) {
      mailOptions.attachments = attachments.map(a => {
        const base64Data = a.data.includes("base64,") ? a.data.split("base64,")[1] : a.data;
        return {
          filename: a.name,
          content: Buffer.from(base64Data, 'base64'),
          contentType: a.type
        };
      });
    }
    const info = await transporter.sendMail(mailOptions);
    console.log(`[Mailer] Email sent to ${to}: ${info.messageId}`);
    return info;
  } catch (error) {
    console.error(`[Mailer Error] Failed to send email to ${to}:`, error.message);
  }
}

// Greeting Helper to format user names nicely and fallback to formatted role if name is a role
function getGreetingName(user) {
  if (!user) return "User";
  const name = user.name || user.id || "User";
  const lower = name.toLowerCase().trim();
  if (lower === "requester" || lower === "approver" || lower === "procurement" || lower === "admin") {
    const role = user.role || lower;
    return role.charAt(0).toUpperCase() + role.slice(1);
  }
  return name.split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// Styling helper (minimized to single lines to prevent email client rendering issues)
const cardStyle = "background-color:#ffffff;border-radius:12px;border:1px solid #e2e8f0;box-shadow:0 4px 6px rgba(0,0,0,0.05);padding:24px;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;max-width:600px;margin:20px auto;color:#1e293b;";
const btnStyle = "display:inline-block;background-color:#007878;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:10px 20px;border-radius:8px;margin-top:15px;";
const tableStyle = "width:100%;border-collapse:collapse;margin-top:15px;font-size:13px;";
const badgeStyle = (color, bg) => `display:inline-block;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700;color:${color};background-color:${bg};text-transform:uppercase;`;

const fmt = n => "Rs. " + Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 });

function buildItemsTable(items) {
  let rows = "";
  items.forEach((it, idx) => {
    const status = it.itemStatus || "pending";
    const label = status === "approved" ? "Approved" : status === "rejected" ? "Rejected" : "Pending";
    const css = status === "approved"
      ? badgeStyle("#059669", "#dcfce7")
      : status === "rejected"
      ? badgeStyle("#dc2626", "#fee2e2")
      : badgeStyle("#d97706", "#fef9c3");
    const statusBadge = `<span style="${css}">${label}</span>`;

    rows += `
      <tr style="border-bottom: 1px solid #f1f5f9;">
        <td style="padding: 8px 5px; color: #64748b;">${idx + 1}</td>
        <td style="padding: 8px 5px; font-weight: bold; color: #007878;">${it.code}</td>
        <td style="padding: 8px 5px;">${it.desc}</td>
        <td style="padding: 8px 5px; color: #64748b;">${it.qty} ${it.unit || "Nos"}</td>
        <td style="padding: 8px 5px; font-weight: 600;">${fmt(it.amount)}</td>
        <td style="padding: 8px 5px; font-size: 11px; color: #64748b;">${it.vendor || "--"}</td>
        <td style="padding: 8px 5px;">${statusBadge}</td>
      </tr>
    `;
  });

  return `
    <table style="${tableStyle}">
      <thead>
        <tr style="background-color: #f8fafc; border-bottom: 2px solid #e2e8f0; text-align: left;">
          <th style="padding: 8px 5px; color: #64748b; font-size: 11px;">#</th>
          <th style="padding: 8px 5px; color: #64748b; font-size: 11px;">Code</th>
          <th style="padding: 8px 5px; color: #64748b; font-size: 11px;">Desc</th>
          <th style="padding: 8px 5px; color: #64748b; font-size: 11px;">Qty</th>
          <th style="padding: 8px 5px; color: #64748b; font-size: 11px;">Amount</th>
          <th style="padding: 8px 5px; color: #64748b; font-size: 11px;">Vendor</th>
          <th style="padding: 8px 5px; color: #64748b; font-size: 11px;">Status</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  `;
}

function getHeader(titleColor) {
  return `
    <div style="background-color: #004d4d; padding: 20px; border-radius: 12px 12px 0 0; text-align: center;">
      <h1 style="color: #ffffff; margin: 0; font-size: 24px; font-weight: 800; letter-spacing: -0.5px;">PlakshaBudget</h1>
      <div style="color: ${titleColor}; font-size: 12px; font-weight: bold; margin-top: 5px;">DEPARTMENT BUDGET & EXPENSE TRACKING</div>
    </div>
  `;
}

function getFooter() {
  return `
    <div style="text-align: center; margin-top: 25px; padding-top: 15px; border-top: 1px solid #e2e8f0; font-size: 11px; color: #94a3b8;">
      This is an automated notification from your PlakshaBudget system. Please do not reply directly to this email.
    </div>
  `;
}

// ── Email Transition Templates ───────────────────────────────────────────────

async function sendIndentSubmittedMail(indent, requester, level1Approvers) {
  const total = (indent.items || []).reduce((s, it) => s + Number(it.amount || 0), 0);
  const itemsTable = buildItemsTable(indent.items);
  const dateStr = new Date(indent.submittedAt).toLocaleString("en-IN");

  // Email to Level 1 Approvers (individually)
  if (level1Approvers.length > 0) {
    for (const approver of level1Approvers) {
      if (!approver.email) continue;
      const subject = `[Action Required] L1 Approval Pending: Indent ${indent.id} - ${indent.title}`;
      const html = `
        <div style="${cardStyle}">
          ${getHeader("#80cbc4")}
          <h2 style="color: #004d4d; margin-top: 20px;">Approval Requested</h2>
          <p>Hi ${getGreetingName(approver)},</p>
          <p>A new indent has been submitted for your department and is pending your <strong>Level 1 Approval</strong>.</p>
          
          <div style="background-color: #f8fafc; border-left: 4px solid #007878; padding: 12px 16px; margin: 15px 0; border-radius: 4px;">
            <div><strong>Indent ID:</strong> ${indent.id}</div>
            <div><strong>Title:</strong> ${indent.title}</div>
            <div><strong>Submitted By:</strong> ${getGreetingName(requester)} (${requester.id})</div>
            <div><strong>Date Submitted:</strong> ${dateStr}</div>
            <div><strong>Total Amount:</strong> <strong style="color: #007878;">${fmt(total)}</strong></div>
          </div>

          <h3>Line Items Summary</h3>
          ${itemsTable}

          <div style="text-align: center; margin-top: 20px;">
            <a href="${frontendUrl}" style="${btnStyle}">Open PlakshaBudget to Approve</a>
          </div>
          ${getFooter()}
        </div>
      `;
      await sendMail(approver.email, subject, html, undefined, indent.attachments);
    }
  }

  // Confirmation email to Requester
  if (requester.email) {
    const subject = `Indent Submitted: ${indent.id} - ${indent.title}`;
    const html = `
      <div style="${cardStyle}">
        ${getHeader("#80cbc4")}
        <h2 style="color: #004d4d; margin-top: 20px;">Indent Successfully Raised</h2>
        <p>Hi ${getGreetingName(requester)},</p>
        <p>Your indent has been submitted successfully and is now in the approval chain. The budget of <strong>${fmt(total)}</strong> has been reserved.</p>
        
        <div style="background-color: #f8fafc; border-left: 4px solid #d97706; padding: 12px 16px; margin: 15px 0; border-radius: 4px;">
          <div><strong>Indent ID:</strong> ${indent.id}</div>
          <div><strong>Title:</strong> ${indent.title}</div>
          <div><strong>Stage:</strong> <span style="${badgeStyle("#d97706", "#fef9c3")}">Level 1 Approval Pending</span></div>
          <div><strong>Total Reserved:</strong> ${fmt(total)}</div>
        </div>

        <h3>Line Items Summary</h3>
        ${itemsTable}

        <div style="text-align: center; margin-top: 20px;">
          <a href="${frontendUrl}" style="${btnStyle}">Track Request Status</a>
        </div>
        ${getFooter()}
      </div>
    `;
    await sendMail(requester.email, subject, html, undefined, indent.attachments);
  }
}

async function sendIndentForwardedMail(indent, requester, nextApprovers, comment, level) {
  const total = (indent.items || []).reduce((s, it) => s + Number(it.amount || 0), 0);
  const itemsTable = buildItemsTable(indent.items);
  const stageName = `Level ${level + 1} Approval Pending`;

  // Email to Next Level Approvers (individually)
  if (nextApprovers.length > 0) {
    for (const approver of nextApprovers) {
      if (!approver.email) continue;
      const subject = `[Action Required] L${level + 1} Approval Pending: Indent ${indent.id}`;
      const html = `
        <div style="${cardStyle}">
          ${getHeader("#80cbc4")}
          <h2 style="color: #004d4d; margin-top: 20px;">Approval Requested</h2>
          <p>Hi ${getGreetingName(approver)},</p>
          <p>An indent has been approved by the previous level and is now pending your <strong>Level ${level + 1} Approval</strong>.</p>
          
          <div style="background-color: #f8fafc; border-left: 4px solid #007878; padding: 12px 16px; margin: 15px 0; border-radius: 4px;">
            <div><strong>Indent ID:</strong> ${indent.id}</div>
            <div><strong>Title:</strong> ${indent.title}</div>
            <div><strong>Submitted By:</strong> ${getGreetingName(requester)}</div>
            <div><strong>Total Amount:</strong> <strong style="color: #007878;">${fmt(total)}</strong></div>
            ${comment ? `<div><strong>Previous Level Comment:</strong> <span style="font-style: italic; color: #64748b;">"${comment}"</span></div>` : ""}
          </div>

          <h3>Line Items</h3>
          ${itemsTable}

          <div style="text-align: center; margin-top: 20px;">
            <a href="${frontendUrl}" style="${btnStyle}">Open PlakshaBudget to Approve</a>
          </div>
          ${getFooter()}
        </div>
      `;
      await sendMail(approver.email, subject, html, undefined, indent.attachments);
    }
  }

  // Update email to Requester
  if (requester.email) {
    const subject = `Indent Updated: Stage transition for ${indent.id}`;
    const html = `
      <div style="${cardStyle}">
        ${getHeader("#80cbc4")}
        <h2 style="color: #004d4d; margin-top: 20px;">Indent Approved & Forwarded</h2>
        <p>Hi ${getGreetingName(requester)},</p>
        <p>Your indent has been approved at the previous level and forwarded to the next stage.</p>
        
        <div style="background-color: #f8fafc; border-left: 4px solid #d97706; padding: 12px 16px; margin: 15px 0; border-radius: 4px;">
          <div><strong>Indent ID:</strong> ${indent.id}</div>
          <div><strong>Title:</strong> ${indent.title}</div>
          <div><strong>Current Stage:</strong> <span style="${badgeStyle("#d97706", "#fef9c3")}">${stageName}</span></div>
          ${comment ? `<div><strong>Approver Comment:</strong> <span style="font-style: italic;">"${comment}"</span></div>` : ""}
        </div>

        <h3>Line Items Status</h3>
        ${itemsTable}

        ${getFooter()}
      </div>
    `;
    await sendMail(requester.email, subject, html, undefined, indent.attachments);
  }
}

async function sendIndentFinalApprovedMail(indent, requester, procurementUsers, comment) {
  const approvedTotal = (indent.items || []).filter(it => it.itemStatus === "approved").reduce((s, it) => s + Number(it.amount || 0), 0);
  const total = (indent.items || []).reduce((s, it) => s + Number(it.amount || 0), 0);
  const itemsTable = buildItemsTable(indent.items);

  // Email to Procurement Users (individually)
  if (procurementUsers.length > 0) {
    for (const proc of procurementUsers) {
      if (!proc.email) continue;
      const subject = `[New Approved Indent] Action Required: Indent ${indent.id}`;
      const html = `
        <div style="${cardStyle}">
          ${getHeader("#80cbc4")}
          <h2 style="color: #004d4d; margin-top: 20px;">Indent Ready for Procurement</h2>
          <p>Hi ${getGreetingName(proc)},</p>
          <p>An indent has received final approval from all department levels and is now ready for RFQ and Procurement closure.</p>
          
          <div style="background-color: #f8fafc; border-left: 4px solid #059669; padding: 12px 16px; margin: 15px 0; border-radius: 4px;">
            <div><strong>Indent ID:</strong> ${indent.id}</div>
            <div><strong>Title:</strong> ${indent.title}</div>
            <div><strong>Requested By:</strong> ${getGreetingName(requester)}</div>
            <div><strong>Total Approved Amount:</strong> <strong style="color: #059669;">${fmt(approvedTotal)}</strong> (out of ${fmt(total)})</div>
            ${comment ? `<div><strong>Approver Final Comment:</strong> <span style="font-style: italic; color: #64748b;">"${comment}"</span></div>` : ""}
          </div>

          <h3>Line Items Status</h3>
          ${itemsTable}

          <div style="text-align: center; margin-top: 20px;">
            <a href="${frontendUrl}" style="${btnStyle}">Manage Procurement</a>
          </div>
          ${getFooter()}
        </div>
      `;
      await sendMail(proc.email, subject, html, undefined, indent.attachments);
    }
  }

  // Email to Requester
  if (requester.email) {
    const subject = `Indent Final Approved: ${indent.id} - ${indent.title}`;
    const statusLabel = indent.status === "partial" ? "Partially Approved" : "Approved";
    const statusColor = indent.status === "partial" ? "#007878" : "#059669";
    const statusBg = indent.status === "partial" ? "#e0f2f1" : "#dcfce7";

    const html = `
      <div style="${cardStyle}">
        ${getHeader(statusColor)}
        <h2 style="color: #004d4d; margin-top: 20px;">Indent Process Completed</h2>
        <p>Hi ${getGreetingName(requester)},</p>
        <p>Your indent has received its final level approval and has been forwarded to the Procurement Team. Budgets for approved items have been deducted.</p>
        
        <div style="background-color: #f8fafc; border-left: 4px solid ${statusColor}; padding: 12px 16px; margin: 15px 0; border-radius: 4px;">
          <div><strong>Indent ID:</strong> ${indent.id}</div>
          <div><strong>Title:</strong> ${indent.title}</div>
          <div><strong>Final Status:</strong> <span style="${badgeStyle(statusColor, statusBg)}">${statusLabel}</span></div>
          <div><strong>Approved Amount:</strong> <strong style="color: #059669;">${fmt(approvedTotal)}</strong></div>
          ${comment ? `<div><strong>Final Level Comment:</strong> <span style="font-style: italic;">"${comment}"</span></div>` : ""}
        </div>

        <h3>Approved & Rejected Items</h3>
        ${itemsTable}

        <p style="font-size: 12px; color: #64748b; margin-top: 15px;">Any rejected items have had their reserved budget released back to your department budget code balance.</p>

        ${getFooter()}
      </div>
    `;
    await sendMail(requester.email, subject, html, undefined, indent.attachments);
  }
}

async function sendIndentRejectedMail(indent, requester, comment) {
  const itemsTable = buildItemsTable(indent.items);
  const total = (indent.items || []).reduce((s, it) => s + Number(it.amount || 0), 0);

  if (requester.email) {
    const subject = `Indent Rejected: Indent ${indent.id}`;
    const html = `
      <div style="${cardStyle}">
        ${getHeader("#dc2626")}
        <h2 style="color: #1e1b4b; margin-top: 20px;">Indent Rejected</h2>
        <p>Hi ${getGreetingName(requester)},</p>
        <p>We regret to inform you that your indent has been rejected. The reserved budget of <strong>${fmt(total)}</strong> has been released back to your department budget codes.</p>
        
        <div style="background-color: #fee2e2; border-left: 4px solid #dc2626; padding: 12px 16px; margin: 15px 0; border-radius: 4px;">
          <div><strong>Indent ID:</strong> ${indent.id}</div>
          <div><strong>Title:</strong> ${indent.title}</div>
          <div><strong>Status:</strong> <span style="${badgeStyle("#dc2626", "#fee2e2")}">Rejected</span></div>
          ${comment ? `<div><strong>Reason / Comment:</strong> <span style="font-weight: 600; color: #991b1b;">"${comment}"</span></div>` : ""}
        </div>

        <h3>Line Items Status</h3>
        ${itemsTable}

        ${getFooter()}
      </div>
    `;
    await sendMail(requester.email, subject, html, undefined, indent.attachments);
  }
}

async function sendIndentRevisionMail(indent, requester, comment) {
  const itemsTable = buildItemsTable(indent.items);

  if (requester.email) {
    const subject = `Revision Requested: Indent ${indent.id}`;
    const html = `
      <div style="${cardStyle}">
        ${getHeader("#7c3aed")}
        <h2 style="color: #1e1b4b; margin-top: 20px;">Revision Requested</h2>
        <p>Hi ${getGreetingName(requester)},</p>
        <p>An approver has sent your indent back for revision. You can edit the indent, adjust the items or notes, and re-submit it for approval.</p>
        
        <div style="background-color: #f5f3ff; border-left: 4px solid #7c3aed; padding: 12px 16px; margin: 15px 0; border-radius: 4px;">
          <div><strong>Indent ID:</strong> ${indent.id}</div>
          <div><strong>Title:</strong> ${indent.title}</div>
          <div><strong>Status:</strong> <span style="${badgeStyle("#7c3aed", "#ede9fe")}">Revision Requested</span></div>
          ${comment ? `<div><strong>Feedback / Revision Note:</strong> <span style="font-weight: 600; color: #5b21b6;">"${comment}"</span></div>` : ""}
        </div>

        <h3>Line Items</h3>
        ${itemsTable}

        <div style="text-align: center; margin-top: 20px;">
          <a href="${frontendUrl}" style="${btnStyle}">Edit and Re-submit Indent</a>
        </div>
          ${getFooter()}
      </div>
    `;
    await sendMail(requester.email, subject, html, undefined, indent.attachments);
  }
}

async function sendIndentClosedMail(indent, requester, actionedBy) {
  const approvedTotal = (indent.items || []).filter(it => it.itemStatus === "approved").reduce((s, it) => s + Number(it.amount || 0), 0);
  const itemsTable = buildItemsTable(indent.items);

  if (requester.email) {
    const subject = `Procurement Completed: Indent ${indent.id}`;
    const html = `
      <div style="${cardStyle}">
        ${getHeader("#059669")}
        <h2 style="color: #1e1b4b; margin-top: 20px;">Procurement Process Closed</h2>
        <p>Hi ${getGreetingName(requester)},</p>
        <p>Your approved indent has been marked as <strong>Procurement Closed</strong>. All items have been ordered or processed.</p>
        
        <div style="background-color: #f0fdf4; border-left: 4px solid #059669; padding: 12px 16px; margin: 15px 0; border-radius: 4px;">
          <div><strong>Indent ID:</strong> ${indent.id}</div>
          <div><strong>Title:</strong> ${indent.title}</div>
          <div><strong>Status:</strong> <span style="${badgeStyle("#059669", "#dcfce7")}">Procurement Closed</span></div>
          <div><strong>Procured Value:</strong> ${fmt(approvedTotal)}</div>
          <div><strong>Processed By:</strong> ${getGreetingName(actionedBy)}</div>
        </div>

        <h3>Items Processed</h3>
        ${itemsTable}

        ${getFooter()}
      </div>
    `;
    await sendMail(requester.email, subject, html, undefined, indent.attachments);
  }
}

async function sendRFQMail(vendorEmail, subject, bodyText) {
  // Directly send email to a vendor
  await sendMail(vendorEmail, subject, bodyText.replace(/\n/g, "<br>"));
}

async function sendRFQMail(vendorEmail, subject, bodyText) {
  // Directly send email to a vendor
  await sendMail(vendorEmail, subject, bodyText.replace(/\n/g, "<br>"));
}

module.exports = {
  sendMail,
  sendIndentSubmittedMail,
  sendIndentForwardedMail,
  sendIndentFinalApprovedMail,
  sendIndentRejectedMail,
  sendIndentRevisionMail,
  sendIndentClosedMail,
  sendRFQMail,
};
