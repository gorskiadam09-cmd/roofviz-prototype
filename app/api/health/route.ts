import { NextResponse } from "next/server";
export async function GET() {
  return NextResponse.json({
    hasGmailUser: !!process.env.GMAIL_USER,
    hasGmailPass: !!process.env.GMAIL_APP_PASSWORD,
    gmailUserLen: (process.env.GMAIL_USER ?? "").length,
    gmailPassLen: (process.env.GMAIL_APP_PASSWORD ?? "").length,
    gmailPassEndsNewline: (process.env.GMAIL_APP_PASSWORD ?? "").endsWith("\n"),
    hasResend: !!process.env.RESEND_API_KEY,
    hasBlob: !!process.env.BLOB_READ_WRITE_TOKEN,
  });
}
