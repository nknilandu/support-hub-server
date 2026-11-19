require("dotenv").config();

const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

const { MongoClient, ServerApiVersion } = require("mongodb");

const {
  analyzeTicket,
  chatWithAssistant,
  suggestAgentReply,
} = require("./ai-agents");

// Route files
const createCommonRoutes = require("./routes/common.routes");
const createCustomerRoutes = require("./routes/customer/customer.routes");
const createAgentRoutes = require("./routes/agent/agent.routes");
const createManagerRoutes = require("./routes/manager/manager.routes");
const createOwnerRoutes = require("./routes/owner/owner.routes");
const createAiRoutes = require("./routes/ai.routes");

const app = express();
const port = process.env.PORT || 3000;

// =====================================================
// EXPRESS MIDDLEWARE
// =====================================================

app.use(cors());
app.use(express.json({ limit: "1mb" }));

// =====================================================
// FIREBASE ADMIN
// =====================================================

if (!admin.apps.length) {
  const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
    "utf8",
  );
  const serviceAccount = JSON.parse(decoded);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

// =====================================================
// VERIFY FIREBASE TOKEN
// =====================================================

const verifyFirebaseToken = async (req, res, next) => {
  const authorization = req.headers.authorization;

  if (
    typeof authorization !== "string" ||
    !/^Bearer\s+\S+$/i.test(authorization)
  ) {
    return res.status(401).send({
      success: false,
      message: "Authentication required",
    });
  }

  const token = authorization.split(/\s+/)[1];

  try {
    const decodedToken = await admin.auth().verifyIdToken(token);

    req.user = decodedToken;
  } catch {
    return res.status(401).send({
      success: false,
      message: "Invalid or expired token",
    });
  }

  next();
};

// =====================================================
// MONGODB
// =====================================================

const uri =
  process.env.MONGODB_URI ||
  `mongodb+srv://${encodeURIComponent(
    process.env.DB_USER || "",
  )}:${encodeURIComponent(
    process.env.DB_PASS || "",
  )}@cluster-support-hub.idvmsjp.mongodb.net/?appName=Cluster-Support-Hub`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

// =====================================================
// START SERVER
// =====================================================

async function run() {
  // await client.connect();

  const DB = client.db("supportHub");

  // Collections
  const users = DB.collection("users");
  const companies = DB.collection("companies");
  const tickets = DB.collection("tickets");
  const notifications = DB.collection("notifications");

  const supportConversations = DB.collection("supportConversations");
  const aiConversations = DB.collection("aiConversations");
  const aiMessages = DB.collection("aiMessages");

  const invoices = DB.collection("invoices");

  // =====================================================
  // INDEXES
  // =====================================================

  await users.createIndex(
    { uid: 1 },
    {
      unique: true,
      partialFilterExpression: {
        uid: { $type: "string" },
      },
    },
  );

  await supportConversations.createIndex({
    ticketId: 1,
    createdAt: 1,
    _id: 1,
  });

  await notifications.createIndex({
    uid: 1,
    createdAt: -1,
    _id: -1,
  });

  await notifications.createIndex({
    uid: 1,
    isRead: 1,
  });

  await aiMessages.createIndex({
    conversationId: 1,
    createdAt: -1,
    _id: -1,
  });

  await tickets.createIndex({
    companyId: 1,
    updatedAt: -1,
    _id: -1,
  });

  await users.createIndex({
    companyId: 1,
    role: 1,
    verifyIdAgent: 1,
    createdAt: 1,
  });

  await notifications.createIndex({
    uid: 1,
    companyId: 1,
    createdAt: -1,
    _id: -1,
  });

  // =====================================================
  // HOME
  // =====================================================
  // =====================================================
  // HOME
  // =====================================================

  app.get("/", (req, res) => {
    res.type("html").send(`
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>SupportHub API</title>

        <style>
          * {
            box-sizing: border-box;
          }

          body {
            margin: 0;
            min-height: 100vh;
            display: grid;
            place-items: center;
            padding: 24px;
            background: #0f0b14;
            color: #f472b6;
            font-family: monospace;
          }

          main {
            width: 100%;
            text-align: center;
          }

          .banner {
            overflow-x: auto;
            padding: 16px 0;
          }

          pre {
            display: inline-block;
            margin: 0;
            text-align: left;
            font-size: clamp(8px, 1.5vw, 16px);
            line-height: 1.3;
            text-shadow: 0 0 16px #ec489955;
          }

          p {
            margin: 24px 0 0;
            font-size: 14px;
            letter-spacing: 1px;
          }

          .status {
            display: inline-block;
            width: 8px;
            height: 8px;
            margin-right: 8px;
            border-radius: 50%;
            background: #4ade80;
          }
        </style>
      </head>

      <body>
        <main>
          <div class="banner">
            <pre>
 ____                              _   _   _       _
/ ___| _   _ _ __  _ __   ___  _ __| |_| | | |_   _| |__
\\___ \\| | | | '_ \\| '_ \\ / _ \\| '__| __| |_| | | | | '_ \\
 ___) | |_| | |_) | |_) | (_) | |  | |_|  _  | |_| | |_) |
|____/ \\__,_| .__/| .__/ \\___/|_|   \\__|_| |_|\\__,_|_.__/
            |_|   |_|
            </pre>
          </div>

        <p style="color: #4ade80;">
  <span class="status"></span>SupportHub server is running
</p>  </main>
      </body>
    </html>
  `);
  });

  // =====================================================
  // COMMON ROUTES
  //
  // Registration, companies, profile,
  // conversations and notifications.
  //
  // Notification creation also stays in this file.
  // =====================================================

  const common = createCommonRoutes({
    client,
    users,
    companies,
    tickets,
    notifications,
    supportConversations,
    verifyFirebaseToken,
  });

  app.use("/", common.router);

  const createNotification = common.createNotification;

  // =====================================================
  // CUSTOMER ROUTES
  // =====================================================

  app.use(
    "/",
    createCustomerRoutes({
      users,
      companies,
      tickets,
      verifyFirebaseToken,
      createNotification,
    }),
  );

  // =====================================================
  // AGENT ROUTES
  // =====================================================

  app.use(
    "/",
    createAgentRoutes({
      users,
      companies,
      tickets,
      supportConversations,
      verifyFirebaseToken,
      createNotification,
      suggestAgentReply,
    }),
  );

  // =====================================================
  // MANAGER ROUTES
  // =====================================================

  app.use(
    "/",
    createManagerRoutes({
      client,
      users,
      companies,
      tickets,
      notifications,
      verifyFirebaseToken,
      createNotification,
    }),
  );

  // =====================================================
  // OWNER ROUTES
  // =====================================================

  app.use(
    "/",
    createOwnerRoutes({
      client,
      users,
      companies,
      tickets,
      notifications,
      invoices,
      verifyFirebaseToken,
      createNotification,
    }),
  );

  // =====================================================
  // AI ROUTES
  // =====================================================

  app.use(
    createAiRoutes({
      client,
      users,
      companies,
      tickets,
      aiConversations,
      aiMessages,
      verifyFirebaseToken,
      analyzeTicket,
      chatWithAssistant,
    }),
  );

  // =====================================================
  // ROUTE NOT FOUND
  // =====================================================

  app.use((req, res) => {
    return res.status(404).send({
      success: false,
      message: "Route not found",
    });
  });

  // =====================================================
  // ERROR HANDLER
  // =====================================================

  app.use((error, req, res, next) => {
    if (res.headersSent) {
      return next(error);
    }

    const errorStatus = error.status || error.statusCode;

    const status =
      Number.isInteger(errorStatus) && errorStatus >= 400 && errorStatus <= 599
        ? errorStatus
        : 500;

    if (status >= 500) {
      console.error(`${req.method} ${req.path}:`, error.message);
    }

    return res.status(status).send({
      success: false,
      message: status >= 500 ? "Internal server error" : error.message,
    });
  });

  // Listen after database and routes are ready.
  app.listen(port, () => {
    console.log(`SupportHub server listening on port ${port}`);
  });
}

run().catch(async (error) => {
  console.error("Server startup failed:", error);

  await client.close();
  process.exitCode = 1;
});
