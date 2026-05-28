const webhookUrl = process.env.TEAMS_WEBHOOK_URL;
const approvalFlowUrl = process.env.TEAMS_APPROVAL_FLOW_URL;
const callbackKey = process.env.TEAMS_CALLBACK_KEY || "teams_approval_secret_key";
const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5174";

const fmt = n => "Rs. " + Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 });

// Trigger Microsoft Teams native Approvals App via Power Automate
async function triggerTeamsApproval(indent, requester, approver, deptName, level) {
  if (!approvalFlowUrl) {
    console.log("[Teams Approval Flow] TEAMS_APPROVAL_FLOW_URL is not set. Skipping Teams Approval request.");
    return;
  }

  const total = (indent.items || []).reduce((s, it) => s + Number(it.amount || 0), 0);
  const payload = {
    indentId: indent.id,
    title: indent.title || "Indent Request",
    requesterName: requester.name || requester.id,
    requesterEmail: requester.email || "",
    approverId: approver.id,
    approverName: approver.name,
    approverEmail: approver.email,
    deptName: deptName || indent.deptId,
    amount: total,
    level: level,
    callbackUrl: `${frontendUrl}/api/teams-approvals/callback`,
    callbackKey: callbackKey
  };

  try {
    const response = await fetch(approvalFlowUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const txt = await response.text();
      console.error(`[Teams Approval Flow Error] Failed to trigger Power Automate: ${response.status} - ${txt}`);
    } else {
      console.log(`[Teams Approval Flow] Successfully requested Teams Approval for ${indent.id} (Level ${level}) to ${approver.name}`);
    }
  } catch (error) {
    console.error("[Teams Approval Flow Error] Request failed:", error.message);
  }
}

async function sendTeamsMessage(payload) {
  if (!webhookUrl) {
    return;
  }

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const txt = await response.text();
      console.error(`[Teams Error] Failed to send webhook: ${response.status} - ${txt}`);
    } else {
      console.log(`[Teams Notification] Successfully sent message to Teams.`);
    }
  } catch (error) {
    console.error("[Teams Error] Failed to send webhook:", error.message);
  }
}

async function notifyIndentSubmitted(indent, requester, deptName) {
  const total = (indent.items || []).reduce((s, it) => s + Number(it.amount || 0), 0);
  const payload = {
    "@type": "MessageCard",
    "@context": "http://schema.org/extensions",
    "themeColor": "007878",
    "summary": `New Indent Submitted: ${indent.id}`,
    "sections": [{
      "activityTitle": `L1 Approval Pending: Indent ${indent.id}`,
      "activitySubtitle": `Department: ${deptName || indent.deptId}`,
      "facts": [
        { "name": "Title", "value": indent.title || "No Title" },
        { "name": "Submitted By", "value": requester.name || requester.id },
        { "name": "Total Amount", "value": fmt(total) }
      ],
      "markdown": true
    }],
    "potentialAction": [{
      "@type": "OpenUri",
      "name": "Approve in PlakshaBudget",
      "targets": [{ "os": "default", "uri": frontendUrl }]
    }]
  };
  await sendTeamsMessage(payload);
}

async function notifyIndentForwarded(indent, requester, deptName, nextLevel) {
  const total = (indent.items || []).reduce((s, it) => s + Number(it.amount || 0), 0);
  const payload = {
    "@type": "MessageCard",
    "@context": "http://schema.org/extensions",
    "themeColor": "007878",
    "summary": `Indent Forwarded: ${indent.id}`,
    "sections": [{
      "activityTitle": `L${nextLevel} Approval Pending: Indent ${indent.id}`,
      "activitySubtitle": `Department: ${deptName || indent.deptId}`,
      "facts": [
        { "name": "Title", "value": indent.title || "No Title" },
        { "name": "Submitted By", "value": requester.name || requester.id },
        { "name": "Total Amount", "value": fmt(total) },
        { "name": "Next Stage", "value": `Level ${nextLevel} Approval Required` }
      ],
      "markdown": true
    }],
    "potentialAction": [{
      "@type": "OpenUri",
      "name": "Review in PlakshaBudget",
      "targets": [{ "os": "default", "uri": frontendUrl }]
    }]
  };
  await sendTeamsMessage(payload);
}

async function notifyIndentFinalApproved(indent, requester, deptName) {
  const approvedTotal = (indent.items || []).filter(it => it.itemStatus === "approved").reduce((s, it) => s + Number(it.amount || 0), 0);
  const payload = {
    "@type": "MessageCard",
    "@context": "http://schema.org/extensions",
    "themeColor": "059669",
    "summary": `Indent Approved: ${indent.id}`,
    "sections": [{
      "activityTitle": `Indent Ready for Procurement: ${indent.id}`,
      "activitySubtitle": `Department: ${deptName || indent.deptId}`,
      "facts": [
        { "name": "Title", "value": indent.title || "No Title" },
        { "name": "Requested By", "value": requester.name || requester.id },
        { "name": "Approved Amount", "value": fmt(approvedTotal) }
      ],
      "markdown": true
    }],
    "potentialAction": [{
      "@type": "OpenUri",
      "name": "Manage Procurement",
      "targets": [{ "os": "default", "uri": frontendUrl }]
    }]
  };
  await sendTeamsMessage(payload);
}

async function notifyIndentRejected(indent, requester, deptName, comment) {
  const payload = {
    "@type": "MessageCard",
    "@context": "http://schema.org/extensions",
    "themeColor": "dc2626",
    "summary": `Indent Rejected: ${indent.id}`,
    "sections": [{
      "activityTitle": `Indent Rejected: ${indent.id}`,
      "activitySubtitle": `Department: ${deptName || indent.deptId}`,
      "facts": [
        { "name": "Title", "value": indent.title || "No Title" },
        { "name": "Submitted By", "value": requester.name || requester.id },
        { "name": "Comment/Reason", "value": comment || "No comment provided" }
      ],
      "markdown": true
    }],
    "potentialAction": [{
      "@type": "OpenUri",
      "name": "View Indent",
      "targets": [{ "os": "default", "uri": frontendUrl }]
    }]
  };
  await sendTeamsMessage(payload);
}

async function notifyIndentRevision(indent, requester, deptName, comment) {
  const payload = {
    "@type": "MessageCard",
    "@context": "http://schema.org/extensions",
    "themeColor": "7c3aed",
    "summary": `Revision Requested: ${indent.id}`,
    "sections": [{
      "activityTitle": `Revision Requested: ${indent.id}`,
      "activitySubtitle": `Department: ${deptName || indent.deptId}`,
      "facts": [
        { "name": "Title", "value": indent.title || "No Title" },
        { "name": "Submitted By", "value": requester.name || requester.id },
        { "name": "Revision Feedback", "value": comment || "No comment provided" }
      ],
      "markdown": true
    }],
    "potentialAction": [{
      "@type": "OpenUri",
      "name": "Edit Indent",
      "targets": [{ "os": "default", "uri": frontendUrl }]
    }]
  };
  await sendTeamsMessage(payload);
}

async function notifyIndentClosed(indent, requester, deptName, closer) {
  const payload = {
    "@type": "MessageCard",
    "@context": "http://schema.org/extensions",
    "themeColor": "059669",
    "summary": `Procurement Completed: ${indent.id}`,
    "sections": [{
      "activityTitle": `Procurement Closed: ${indent.id}`,
      "activitySubtitle": `Department: ${deptName || indent.deptId}`,
      "facts": [
        { "name": "Title", "value": indent.title || "No Title" },
        { "name": "Submitted By", "value": requester.name || requester.id },
        { "name": "Closed By", "value": closer.name || closer.id }
      ],
      "markdown": true
    }],
    "potentialAction": [{
      "@type": "OpenUri",
      "name": "View in PlakshaBudget",
      "targets": [{ "os": "default", "uri": frontendUrl }]
    }]
  };
  await sendTeamsMessage(payload);
}

module.exports = {
  triggerTeamsApproval,
  notifyIndentSubmitted,
  notifyIndentForwarded,
  notifyIndentFinalApproved,
  notifyIndentRejected,
  notifyIndentRevision,
  notifyIndentClosed,
};
