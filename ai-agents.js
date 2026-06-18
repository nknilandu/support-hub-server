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
  "imageUrls": ["string"] // optional, max 3 images
}

========================================================
CORE OBJECTIVE (MOST IMPORTANT RULE)
========================================================

Your primary goal is NOT to describe the image or text separately.

Your goal is to determine:

👉 "What is the actual user-facing problem?"

You MUST:
- Combine image + description into a single unified diagnosis
- Infer the real issue even if description is vague like:
  - "check screenshot"
  - "here is my issue"
  - "not working"
- Prioritize visual evidence if image exists
- Override vague description with concrete UI/error evidence from image

If conflict exists:
- Image evidence > description ambiguity

========================================================
STRICT RULES
========================================================

1. description is mandatory. If missing → fail logically.
2. imageUrls is optional (max 3 images).
3. NEVER include any text outside JSON.
4. NEVER use markdown.
5. NEVER hallucinate image content.
6. ONLY use visible evidence from images.
7. Output must be valid JSON only.
8. rootCause must be 5–10 sentences.
9. DO NOT restate description — interpret it.

========================================================
IMAGE ANALYSIS RULES (CRITICAL UPGRADE)
========================================================

If imageUrls exist:

You MUST perform layered analysis:

STEP 1 — Visual Extraction
- Extract all visible:
  - error messages
  - UI states
  - warnings
  - system logs
  - buttons/forms states
  - authentication screens
  - failed network/API indicators

STEP 2 — Context Mapping
- Map extracted UI state to possible system failure
- Identify what action user attempted
- Identify where flow broke

STEP 3 — Root Issue Inference
- Convert visual evidence into ONE clear problem statement:
  Example:
  ❌ "Login page error shown"
  ✅ "User authentication failing due to invalid session token or expired login state"

STEP 4 — Cross-check with description
- If description is vague, treat image as primary truth
- If description contradicts image, trust image

========================================================
VISUAL OUTPUT RULES
========================================================

Populate:
- visualEvidence: ONLY concrete visible strings
- visualConfidence: based on clarity of image evidence
- visualInsights must include real inferred impact

visualConfidence meaning:
0–39   = weak evidence
40–59  = moderate evidence
60–79  = strong evidence
80–100 = highly reliable evidence

If NO images:

- visualEvidence = []
- visualConfidence = null
- visualInsights must be:

{
  "detectedErrors": 0,
  "detectedWarnings": 0,
  "affectedComponents": []
}

========================================================
NO-IMAGE MODE RULE
========================================================

If NO images provided:

You must:
- Extract issue purely from description
- If description is vague, infer likely failure category:
  - Authentication
  - API failure
  - UI bug
  - Payment issue
  - Performance issue
  - Missing data

But DO NOT hallucinate UI-specific errors.

========================================================
CONFIDENCE / PRIORITY / RISK RULES
========================================================

Confidence Score:
- value must include "%"
- based on evidence strength (image + text combined)

Priority:
Low = green
Medium = yellow
High = orange
Critical = red

Risk Level:
Same mapping as priority

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
    description: "analysis this screenshot",
    imageUrls: [
      "https://uploads-eu-west-1.insided.com/typeform-en/attachment/f551cae4-36a9-4a10-b30c-459030a5b9f5.png",
    ],
  });

  console.log(JSON.stringify(result, null, 2));
}
// run();

// ---------------------------------------------
// ---------------------------------------------

async function chatWithAssistant({ message, history, userContext }) {
  if (!message?.trim()) {
    throw new Error("message is required");
  }
  if (!userContext) {
    throw new Error("user information is required");
  }

  const model = process.env.OPENROUTER_AI_MODEL;
  const MAX_HISTORY = 10;

  // ===== Slim User Context =====
  const slimUserContext = {
    displayName: userContext?.user?.displayName || null,
    role: userContext?.user?.role || "customer",
  };

  // ===== Compact Prompt =====
  const SYSTEM_PROMPT = `
You are SupportHub AI Assistant.

User Context:
${JSON.stringify(slimUserContext)}

Rules:
- Use userContext.role as primary mode detection.
- If role missing, infer from message.

Modes:
- customer → user needs help solving own issue
- agent → support staff analyzing customer issue

Intent:
- troubleshoot → solve issue
- reply → draft response
- analyze → root cause / diagnosis
- escalate → needs higher support
- action → account/payment/manual action needed

Severity:
- low
- medium
- high
- critical (security, payment, outage, data loss)

Behavior:
- understand issue
- ask follow-up if needed
- avoid hallucination
- use conversation history
- be practical

Customer mode:
- simple language
- step-by-step troubleshooting

Agent mode:
- technical analysis
- root cause
- escalation advice

Return ONLY valid JSON:
{
  "mode": "",
  "intent": "",
  "severity": "",
  "preview": "",
  "details": "",
  "reply": ""
}

preview rules:
- one short line
- maximum 40 characters
- suitable as chat title
- no quotation marks

details rules:
- one short line
- maximum 120 characters
- summarize what the user needs
- no markdown
`;

  // const SYSTEM_PROMPT = `You are SupportHub AI.

  // Mode:
  // - customer
  // - agent

  // User Context:
  // ${JSON.stringify(slimUserContext)}

  // Rules:
  // - Use userContext.role for mode detection.

  // Intent:
  // - troubleshoot
  // - reply
  // - analyze
  // - escalate
  // - action

  // Severity:
  // low | medium | high | critical

  // Customer:
  // simple troubleshooting

  // Agent:
  // technical analysis

  // Return JSON only:
  // {
  //  mode,
  //  intent,
  //  severity,
  //  reply
  // }`

  // ===== Final Messages =====
  const messages = [
    {
      role: "system",
      content: SYSTEM_PROMPT,
    },
    ...history,
    {
      role: "user",
      content: message,
    },
  ];

  try {
    // console.log("Message: ", messages);

    const completion = await openai.chat.completions.create({
      model,
      temperature: 0.3,
      messages,
      // response_format: { type: "json_object" }, // if supported
    });

    const raw = completion.choices[0].message.content;

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = {
        mode: slimUserContext.role || "customer",
        intent: "troubleshoot",
        severity: "medium",
        reply: raw,
      };
    }

    return {
      ...parsed,
      meta: {
        model,
        tokensUsed: completion.usage?.total_tokens || 0,
      },
    };
  } catch (error) {
    console.error("chatWithAssistant error:", error);
    throw new Error("AI response failed");
  }
}

// ===================================================================

module.exports = { analyzeTicket, chatWithAssistant };

// async function chatWithAssistant({
//   message,
//   conversationHistory = [],
//   userContext = {},
// }) {
//   if (!message) {
//     throw new Error("message is required");
//   }

//   const model = process.env.OPENROUTER_AI_MODEL;

//   const SYSTEM_CHAT_PROMPT = `
// You are SupportHub AI Assistant, an enterprise AI support assistant.

// ================================================
// PRIMARY PURPOSE
// ================================================
// You assist in two modes:

// 1. CUSTOMER MODE
// - End users ask for help regarding their own problems.

// 2. SUPPORT AGENT MODE
// - Support staff ask for help analyzing customer problems.

// You must automatically detect the correct mode.

// ================================================
// MODE DETECTION
// ================================================
// CUSTOMER MODE examples:
// - I cannot login
// - My dashboard is broken
// - Payment failed

// SUPPORT AGENT MODE examples:
// - Customer says payment failed
// - Analyze this ticket
// - Help me draft a response

// Default:
// customer

// ================================================
// INTENT DETECTION
// ================================================
// Classify user intent into ONE:

// - troubleshoot
// - reply
// - analyze
// - escalate

// Rules:
// troubleshoot:
// User wants solution

// reply:
// User wants message/email/reply draft

// analyze:
// User wants diagnosis / summary

// escalate:
// Issue requires higher support tier

// ================================================
// SEVERITY CLASSIFICATION
// ================================================
// Classify issue:

// low:
// Minor inconvenience

// medium:
// Partial workflow blocked

// high:
// Major workflow blocked

// critical:
// Security issue / outage / payment failure / data loss

// ================================================
// BEHAVIOR RULES
// ================================================
// Always:
// - Understand real problem
// - Ask follow-up if needed
// - Avoid hallucination
// - Be practical
// - Use conversation history
// - Explain clearly

// CUSTOMER MODE:
// - Use simple language
// - Be empathetic
// - Step-by-step troubleshooting

// AGENT MODE:
// - Think like senior support engineer
// - Help classify issue
// - Suggest root causes
// - Draft professional responses if needed

// ================================================
// REPLY RULES
// ================================================
// Return ONLY valid JSON.

// Schema:

// {
//   "mode": "customer | agent",
//   "intent": "troubleshoot | reply | analyze | escalate",
//   "severity": "low | medium | high | critical",
//   "reply": "assistant response here"
// }
// `;

//   const messages = [
//     {
//       role: "system",
//       content: SYSTEM_CHAT_PROMPT,
//     },
//   ];

//   if (Object.keys(userContext).length) {
//     messages.push({
//       role: "system",
//       content: `User Context: ${JSON.stringify(userContext)}`,
//     });
//   }

//   if (conversationHistory.length) {
//     conversationHistory.forEach((msg) => {
//       messages.push({
//         role: msg.sender === "ai" ? "assistant" : "user",
//         content: msg.message,
//       });
//     });
//   }

//   messages.push({
//     role: "user",
//     content: message,
//   });

//   const completion = await openai.chat.completions.create({
//     model,
//     temperature: 0.3,
//     messages,
//   });

//   console.log(messages)

//   const raw = completion.choices[0].message.content;
//   const parsed = safeParse(raw);

//   return {
//     ...parsed,
//     meta: {
//       model,
//       tokensUsed: completion.usage?.total_tokens || 0,
//     },
//   };
// }
