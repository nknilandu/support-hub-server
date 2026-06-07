const OpenAI = require("openai");
require("dotenv").config();

const openai = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
});

/* ---------------- CLEAN JSON ---------------- */
function cleanJson(text) {
  return text
    .replace(/```json/g, "")
    .replace(/```/g, "")
    .trim();
}

/* ---------------- SAFE PARSER ---------------- */
function safeParse(raw) {
  try {
    return JSON.parse(cleanJson(raw));
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");

    if (start === -1 || end === -1 || end <= start) {
      throw new Error("Invalid JSON structure");
    }

    const jsonStr = raw.slice(start, end + 1);

    try {
      return JSON.parse(jsonStr);
    } catch {
      throw new Error("Corrupted JSON from AI");
    }
  }
}

/* ---------------- MODEL GUARD ---------------- */
function supportsVision(model) {
  if (!model) return false;
  return model.includes("vision") || model.includes("gpt-4");
}

/* ---------------- SYSTEM PROMPT ---------------- */
const SYSTEM_PROMPT = `You are an enterprise AI support ticket analyzer.

Your job is to analyze a user support ticket using:
- text description (mandatory)
- optional screenshots (imageUrls, max 3)

You must produce a strict structured JSON response.

========================================================
INPUT FORMAT
========================================================
{
  "description": "string",
  "imageUrls": ["string"] // optional, max 3
}

========================================================
STRICT RULES
========================================================

1. description is mandatory. If missing → fail logically.
2. imageUrls is optional (max 3 images only).
3. NEVER include any text outside JSON.
4. NEVER use markdown.
5. NEVER hallucinate image content.
6. Output must be valid JSON only.
7. No duplicate recommendations.
8. rootCause must be 5–10 sentences.

========================================================
VISUAL ANALYSIS RULES (IF IMAGES EXIST)
========================================================

If imageUrls exist:

- Analyze screenshots carefully.
- Extract ONLY visible:
  - errors
  - warnings
  - UI states
  - authentication issues
  - error codes
  - system messages

Populate:
- visualEvidence array
- visualConfidence (0–100)
- visualInsights object

visualConfidence meaning:
0–39   = weak evidence
40–59  = moderate evidence
60–79  = strong evidence
80–100 = highly reliable evidence

If NO images provided:

- visualEvidence = []
- visualConfidence = null
- visualInsights must be:

{
  "detectedErrors": 0,
  "detectedWarnings": 0,
  "affectedComponents": []
}

========================================================
CONFIDENCE / PRIORITY / RISK RULES
========================================================

Confidence Score:
- value must include "%"
- 0–39 = red
- 40–59 = orange
- 60–79 = yellow
- 80–100 = green

Priority:
Low = green
Medium = yellow
High = orange
Critical = red

Risk Level:
Low = green
Medium = yellow
High = orange
Critical = red

========================================================
OUTPUT SCHEMA (MUST FOLLOW EXACTLY)
========================================================

{
  "ticketTitle": "string",
  "summary": "string",
  "category": "Technical | Billing | Account | Bug | Feature | General",

  "rootCause": "string",

  "visualEvidence": ["string"],

  "visualInsights": {
    "detectedErrors": 0,
    "detectedWarnings": 0,
    "affectedComponents": []
  },

  "visualConfidence": 91,

  "metrics": [
    {
      "label": "string",
      "value": "string"
    }
  ],

  "states": [
    {
      "title": "Confidence Score",
      "value": "87%",
      "description": "string",
      "variant": "green"
    },
    {
      "title": "Priority",
      "value": "High",
      "description": "string",
      "variant": "orange"
    },
    {
      "title": "Risk Level",
      "value": "Low",
      "description": "string",
      "variant": "green"
    }
  ],

  "recommendations": [
    {
      "title": "string",
      "impact": "Low | Medium | High",
      "variant": "green | orange | red",
      "description": "string"
    }
  ],

  "steps": [
    {
      "id": 1,
      "title": "string",
      "description": "string",
      "impact": "Low | Medium | High",
      "estimatedTime": "string"
    }
  ],

  "escalation": {
    "recommended": false,
    "reason": "string",
    "confidence": 92
  }
}

========================================================
FINAL OUTPUT RULE
========================================================

Return ONLY valid JSON.
No markdown.
No explanation.
No extra fields.
Must match schema exactly.`;

/* ---------------- MAIN FUNCTION ---------------- */
async function analyzeTicket({ description, imageUrls = [] }) {
  if (!description) {
    throw new Error("description is required");
  }

  const model = process.env.OPENROUTER_AI_MODEL;

  const safeImages = Array.isArray(imageUrls)
    ? imageUrls
        .filter((u) => typeof u === "string" && u.startsWith("http"))
        .slice(0, 3)
    : [];

  // vision fallback safety
  if (!supportsVision(model)) {
    safeImages.length = 0;
  }

  const content = [
    {
      type: "text",
      text: `User Issue:\n${description}`,
    },
  ];

  safeImages.forEach((url) => {
    content.push({
      type: "image_url",
      image_url: { url },
    });
  });

  const completion = await openai.chat.completions.create({
    model,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content: SYSTEM_PROMPT,
      },
      {
        role: "user",
        content,
      },
    ],
  });

  const raw = completion.choices[0].message.content;

  return safeParse(raw);
}

/* ---------------- RUN TEST ---------------- */
async function run() {
  const result = await analyzeTicket({
    description: "Cannot access here",
    imageUrls: [
      "https://uploads-eu-west-1.insided.com/typeform-en/attachment/f551cae4-36a9-4a10-b30c-459030a5b9f5.png",
    ],
  });

  console.log(JSON.stringify(result, null, 2));
}
// run();

// ---------------------------------------------

module.exports = { analyzeTicket };
