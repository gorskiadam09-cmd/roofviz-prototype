import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

const SYSTEM_PROMPT = `You are a roofing geometry expert. Analyze roof photos and return precise polygon outlines.`;

const USER_PROMPT = `Analyze this roof photo and identify the main visible roof surface boundary.

Return ONLY a JSON object in this exact format:
{
  "polygon": [{"x": 0.12, "y": 0.08}, {"x": 0.88, "y": 0.08}, ...],
  "confidence": 0.85
}

Rules:
- x and y are normalized coordinates (0.0 = left/top edge of image, 1.0 = right/bottom edge)
- Trace the outer boundary of the main visible roof surface, clockwise
- Use 4–10 points — trace major corners only, skip tiny details
- For aerial/top-down: trace the full roof perimeter
- For street-level facade: trace the roofline polygon (ridge at top, eaves at bottom, rakes on sides)
- confidence: 0.0–1.0 based on how clearly the roof boundary is visible
- If no clear roof is visible, return { "polygon": [], "confidence": 0 }
- Return ONLY valid JSON — no markdown, no explanation, no other text`;

export async function POST(req: NextRequest) {
  try {
    const { imageBase64, mimeType } = (await req.json()) as {
      imageBase64: string;
      mimeType: string;
    };

    if (!imageBase64) {
      return NextResponse.json({ error: "Missing imageBase64" }, { status: 400 });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 500 });
    }

    const client = new Anthropic({ apiKey });

    const message = await client.messages.create({
      model: "claude-opus-4-6",
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: (mimeType || "image/jpeg") as
                  | "image/jpeg"
                  | "image/png"
                  | "image/gif"
                  | "image/webp",
                data: imageBase64,
              },
            },
            { type: "text", text: USER_PROMPT },
          ],
        },
      ],
    });

    const content = message.content[0];
    if (content.type !== "text") {
      throw new Error("Unexpected response type from AI");
    }

    // Extract JSON — Claude sometimes wraps it in markdown fences
    const jsonMatch = content.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No JSON found in AI response");
    }

    const result = JSON.parse(jsonMatch[0]) as {
      polygon: { x: number; y: number }[];
      confidence: number;
    };

    return NextResponse.json(result);
  } catch (err) {
    console.error("[ai/roof-outline]", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
