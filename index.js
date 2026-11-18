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
// const createPlatformRoutes = require("./routes/platform/platform.routes");
const createAiRoutes = require("./routes/ai.routes");

const app = express();
const port = process.env.PORT || 3021;

// =====================================================
// EXPRESS MIDDLEWARE
// =====================================================

app.use(cors());
app.use(express.json({ limit: "1mb" }));

// =====================================================
// FIREBASE ADMIN
// =====================================================

if (!admin.apps.length) {
  const serviceAccount = require("./support-hub-ai-firebase-admin-sdk.json");

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
  await client.connect();

  const DB = client.db("supportHub");

  // Collections
  const users = DB.collection("users");
  const companies = DB.collection("companies");
  const tickets = DB.collection("tickets");
  const notifications = DB.collection("notifications");

  const supportConversations = DB.collection("supportConversations");
  const aiConversations = DB.collection("aiConversations");
  const aiMessages = DB.collection("aiMessages");

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

  app.get("/", (req, res) => {
    res.send("SupportHub server is running");
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
  // PLATFORM ADMIN ROUTES
  // =====================================================

  // app.use(
  //   "/",
  //   createPlatformRoutes({
  //     users,
  //     companies,
  //     tickets,
  //     verifyFirebaseToken,
  //     createNotification,
  //   }),
  // );

  // =====================================================
  // AI ROUTES
  // =====================================================

  app.use(
    "/",
    createAiRoutes({
      client,
      users,
      companies,
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
