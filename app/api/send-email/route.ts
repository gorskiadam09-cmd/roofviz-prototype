import { Resend } from "resend";
import { NextRequest, NextResponse } from "next/server";

function getResend() {
  return new Resend(process.env.RESEND_API_KEY);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidUrl(s: string): boolean {
  try {
    new URL(s);
    return true;
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  const { to, shareUrl, projectName } = await req.json();

  if (!to || !shareUrl) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  if (!EMAIL_RE.test(to)) {
    return NextResponse.json({ error: "Invalid email address" }, { status: 400 });
  }

  if (!isValidUrl(shareUrl)) {
    return NextResponse.json({ error: "Invalid share URL" }, { status: 400 });
  }

  const from = process.env.RESEND_FROM_EMAIL || "RoofViz <noreply@tryroofviz.com>";

  console.log("RESEND_API_KEY set:", !!process.env.RESEND_API_KEY);
  console.log("RESEND_FROM_EMAIL:", from);
  console.log("Sending RoofViz share email", { to, shareUrl, projectName });

  const { error } = await getResend().emails.send({
    from,
    to,
    subject: `Your ${projectName ?? "Roof"} Visualization`,
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#1e293b">
        <img src="https://roofviz-prototype-1ycw.vercel.app/roofviz-logo.png" alt="RoofViz" width="120" style="margin-bottom:24px"/>
        <h2 style="margin:0 0 12px;font-size:20px">Your roof visualization is ready</h2>
        <p style="margin:0 0 24px;color:#475569;font-size:15px;line-height:1.6">
          Click the button below to view your interactive roof visualization for <strong>${projectName ?? "your project"}</strong>.
          You can explore each installation step on any device.
        </p>
        <a href="${shareUrl}"
          style="display:inline-block;background:#ea580c;color:#fff;text-decoration:none;padding:14px 32px;border-radius:10px;font-weight:600;font-size:16px;text-align:center;min-width:200px;-webkit-text-size-adjust:none">
          View Roof Visualization &rarr;
        </a>
        <p style="margin:24px 0 0;font-size:12px;color:#94a3b8">
          Or copy this link: <a href="${shareUrl}" style="color:#ea580c">${shareUrl}</a>
        </p>
      </div>
    `,
  });

  if (error) {
    console.error("Resend email error", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
