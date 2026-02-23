import { NextRequest, NextResponse } from "next/server";
import nodemailer from "nodemailer";

export async function POST(req: NextRequest) {
  try {
    const { to, shareUrl, projectName } = (await req.json()) as {
      to: string;
      shareUrl: string;
      projectName: string;
    };

    if (!to || !shareUrl) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    });

    await transporter.verify();
    const info = await transporter.sendMail({
      from: `RoofViz <${process.env.GMAIL_USER}>`,
      to,
      subject: `${projectName} — Your Roof Installation Preview`,
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#0f172a;">
          <img src="https://roofviz-prototype.vercel.app/roofviz-logo.png" alt="RoofViz" width="148" style="margin-bottom:24px;" />
          <h2 style="font-size:20px;font-weight:800;margin:0 0 12px;">Your Roof Installation Preview</h2>
          <p style="font-size:15px;color:#475569;line-height:1.65;margin:0 0 24px;">
            Your contractor has prepared a personalized preview of your <strong>${projectName}</strong> roof installation.
            Click the button below to step through each layer — from tear-off to finished shingles — and try different shingle colors.
          </p>
          <a href="${shareUrl}"
             style="display:inline-block;padding:14px 28px;background:linear-gradient(135deg,#2563eb,#1d4ed8);color:#fff;font-size:15px;font-weight:700;text-decoration:none;border-radius:10px;box-shadow:0 2px 8px rgba(37,99,235,0.35);">
            View Your Roof Preview →
          </a>
          <p style="font-size:12px;color:#94a3b8;margin:28px 0 0;line-height:1.6;">
            No sign-up required. Just open the link and explore.<br />
            If the button doesn't work, copy this link into your browser:<br />
            <a href="${shareUrl}" style="color:#2563eb;word-break:break-all;">${shareUrl}</a>
          </p>
        </div>
      `,
    });

    console.log("Email sent:", info.messageId, info.response);
    return NextResponse.json({ ok: true, messageId: info.messageId });
  } catch (err) {
    console.error("send-email error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
