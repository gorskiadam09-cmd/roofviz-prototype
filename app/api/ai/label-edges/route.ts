import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

const SYSTEM_PROMPT = `You are a roofing geometry expert. Analyze facade roof photos and identify structural lines inside a traced outline.`;

export async function POST(req: NextRequest) {
  try {
    const { imageBase64, mimeType, outline } = (await req.json()) as {
      imageBase64: string;
      mimeType: string;
      outline: { x: number; y: number }[];
    };

    if (!imageBase64 || !outline) {
      return NextResponse.json({ error: "Missing imageBase64 or outline" }, { status: 400 });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 500 });
    }

    const client = new Anthropic({ apiKey });

    const userPrompt = `A roof outline polygon has already been traced on this facade photo.
Outline vertices (normalized 0–1, origin = top-left):
${JSON.stringify(outline)}

Identify the ridge line and any valley lines visible INSIDE this outline.

Return ONLY valid JSON:
{
  "suggestions": [
    { "kind": "RIDGE", "points": [{"x":0.15,"y":0.12},{"x":0.85,"y":0.12}], "confidence": 0.9 },
    { "kind": "VALLEY", "points": [{"x":0.5,"y":0.12},{"x":0.65,"y":0.45}], "confidence": 0.7 }
  ]
}

Rules:
- kind must be "RIDGE" or "VALLEY" only
- Each suggestion has exactly 2 points (start + end of the line)
- If no ridge or valleys are clearly visible, return { "suggestions": [] }
- Return ONLY valid JSON — no markdown, no explanation`;

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
            { type: "text", text: userPrompt },
          ],
        },
      ],
    });

    const content = message.content[0];
    if (content.type !== "text") {
      throw new Error("Unexpected response type from AI");
    }

    const jsonMatch = content.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No JSON found in AI response");
    }

    const result = JSON.parse(jsonMatch[0]) as {
      suggestions: { kind: "RIDGE" | "VALLEY"; points: { x: number; y: number }[]; confidence: number }[];
    };

    return NextResponse.json(result);
  } catch (err) {
    console.error("[ai/label-edges]", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
