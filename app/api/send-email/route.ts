import { Resend } from "resend";
import { NextRequest, NextResponse } from "next/server";

const resend = new Resend(process.env.RESEND_API_KEY);

export async function POST(req: NextRequest) {
  const { to, shareUrl, projectName } = await req.json();

  if (!to || !shareUrl) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  const from = process.env.RESEND_FROM_EMAIL ?? "RoofViz <onboarding@resend.dev>";

  const { error } = await resend.emails.send({
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
          style="display:inline-block;background:linear-gradient(135deg,#2563eb,#1d4ed8);color:#fff;text-decoration:none;padding:13px 28px;border-radius:10px;font-weight:600;font-size:15px">
          View Roof Visualization →
        </a>
        <p style="margin:24px 0 0;font-size:12px;color:#94a3b8">
          Or copy this link: <a href="${shareUrl}" style="color:#2563eb">${shareUrl}</a>
        </p>
      </div>
    `,
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
