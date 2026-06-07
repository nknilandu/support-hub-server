const OpenAI = require("openai");
require("dotenv").config();

const openai = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
});

async function main() {
  try {
    console.log("Starting...");
    console.log("Model:", process.env.OPENROUTER_AI_MODEL);
    console.log("Key exists:", !!process.env.OPENROUTER_API_KEY);

    const systemPrompt = `
You are a strict AI ticket analysis engine.

OUTPUT RULES (VERY IMPORTANT):
- Output ONLY valid JSON
- No markdown, no explanations, no extra text
- Must strictly follow schema

SCHEMA:

{
  "ticketTitle": string,
  "summary": string,
  "category": "Technical | Billing | Account | Bug | Feature | General",
  "rootCause": string,

  "metrics": [
    { "label": string, "value": string }
  ],

  "states": [
    {
      "title": "Confidence Score | Priority | Risk Level",
      "value": string,
      "description": string,
      "variant": "green | yellow | orange | red"
    }
  ],

  "recommendations": [
    {
      "title": string,
      "impact": "Low | Medium | High",
      "variant": "green | orange | red",
      "description": string
    }
  ],

  "steps": [
    {
      "id": number,
      "title": string,
      "description": string,
      "impact": "Low | Medium | High",
      "estimatedTime": string
    }
  ],

  "escalation": {
    "recommended": boolean,
    "reason": string,
    "confidence": number
  }
}

STRICT BUSINESS RULES:

1. states array MUST ALWAYS contain exactly 3 objects:
   - Confidence Score
   - Priority
   - Risk Level

2. Confidence Score rules:
   - value must include "%"
   - variant based on value:
     0–39 = red
     40–59 = orange
     60–79 = yellow
     80–100 = green

3. Priority mapping:
   Low = green
   Medium = yellow
   High = orange
   Critical = red

4. Risk Level mapping:
   Low = green
   Medium = yellow
   High = orange
   Critical = red

5. escalation MUST ALWAYS include:
   - recommended (boolean)
   - reason (string)
   - confidence (number 0–100)

6. rootCause must be 5–10 sentences

7. No duplicate recommendation titles

Be precise. No hallucination. Follow schema strictly.
`;

    const userInput = `
Ticket: Unable to connect Slack integration after workspace update.
User reports integration stopped syncing and authentication keeps failing.
`;

    const completion = await openai.chat.completions.create({
      model: process.env.OPENROUTER_AI_MODEL,
      temperature: 0.2,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userInput },
      ],
    });

    console.log("Completed");

    const raw = completion.choices[0].message.content;

    // Safe JSON parsing (important)
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.error("Invalid JSON returned from model:");
      console.log(raw);
      return;
    }

    console.log("Parsed Result:");
    console.dir(parsed, { depth: null });
  } catch (error) {
    console.error("Error:", error.message);
  }
}

main();
