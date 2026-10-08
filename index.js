const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const app = express();
const port = process.env.PORT || 3021;
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const {
  analyzeTicket,
  chatWithAssistant,
  suggestAgentReply,
} = require("./ai-agents");
require("dotenv").config();

// middleware
app.use(cors());
app.use(express.json());

// firebase admin setup
const admin = require("firebase-admin");
const serviceAccount = require("./support-hub-ai-firebase-admin-sdk.json");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// ============= generate Ticket Number ================
const generateTicketNumber = () => {
  const timePart = Date.now().toString(16).slice(-4).toUpperCase();
  const randomPart = crypto.randomBytes(2).toString("hex").toUpperCase();
  return `TCK-${timePart}${randomPart}`;
};

//=============  verifyFirebaseToken =================
// ===================================================
const verifyFirebaseToken = async (req, res, next) => {
  if (!req.headers.authorization) {
    return res
      .status(401)
      .send({ message: "Unauthorized Access – Authentication required" });
  }
  const token = req.headers.authorization.split(" ")[1];
  if (!token) {
    return res
      .status(401)
      .send({ message: "Unauthorized Access – Authentication required" });
  }

  // verify token
  try {
    const tokenInfo = await admin.auth().verifyIdToken(token);
    req.user = tokenInfo;
    next();
  } catch {
    return res
      .status(401)
      .send({ message: "Unauthorized Access – Authentication required" });
  }
};

// ======================== mongodb connection ============================
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster-support-hub.idvmsjp.mongodb.net/?appName=Cluster-Support-Hub`;

console.log(uri);

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

app.get("/", (req, res) => {
  res.send("Successfully Connected to SupportHub");
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    // ++++++++++++++++++++++++++++++++++++++++++++++++
    const DB = client.db("supportHub");
    const users = DB.collection("users");
    const companies = DB.collection("companies");
    const tickets = DB.collection("tickets");
    const notifications = DB.collection("notifications");
    const aiConversations = DB.collection("aiConversations");
    const aiMessages = DB.collection("aiMessages");
    const supportConversations = DB.collection("supportConversations");

    // ====================== MiddleWare =======================
    // ============= Verify Agent ==================
    // ============================================
    const verifyAgent = async (req, res, next) => {
      try {
        const email = req.user.email;
        if (!email) {
          return res.status(401).send({
            success: false,
            message: "Unauthorized access",
          });
        }

        const agent = await users.findOne({ email });
        if (!agent) {
          return res.status(404).send({
            success: false,
            message: "User not found",
          });
        }

        if (agent.role !== "agent") {
          return res.status(403).send({
            success: false,
            message: "Agent access required",
          });
        }
        if (agent.verifyIdAgent !== "approved") {
          return res.status(403).send({
            success: false,
            message: "Your agent account is waiting for admin approval",
          });
        }

        req.agent = agent;
        next();
      } catch (e) {
        return res.status(500).send({
          success: false,
          error: e || "something went wrong",
          message: "Internal server error",
        });
      }
    };
    // ====================== MiddleWare =======================

    // ============= notification function ==================
    const createNotification = async ({
      uid,
      userEmail,
      title,
      message,
      type,
      ticketId = null,
      ticketNumber = null,
      path = "/",
    }) => {
      await notifications.insertOne({
        uid,
        userEmail,
        title,
        message,
        type,
        ticketId,
        ticketNumber,
        path,
        isRead: false,
        readAt: null,
        createdAt: new Date(),
      });
    };

    // ================  Create users collections ===============
    app.post("/users", async (req, res) => {
      try {
        const userBody = req.body;

        if (!userBody?.email) {
          return res.status(400).send({
            success: false,
            message: "Email is required",
          });
        }

        const allowedRoles = ["customer", "agent", "owner"];
        if (!allowedRoles.includes(userBody.role)) {
          return res.status(400).send({
            success: false,
            message: "Invalid account role",
          });
        }

        //const result = client.db('Any_Name').collection('Any_collection_name').insertOne({Object})
        const existingUser = await users.findOne({ email: userBody.email });

        if (existingUser) {
          return res.status(200).send({
            success: true,
            message: "User already exists",
            insertedId: existingUser._id,
            existing: true,
          });
        }

        const newUserBody = {
          ...userBody,
          status: "active",
          verifyIdAgent: userBody.role === "agent" ? "pending" : "approved",
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        const result = await users.insertOne(newUserBody);

        if (result.acknowledged) {
          return res.status(201).send({
            success: true,
            message: "User added successfully",
            insertedId: result.insertedId,
            existing: false,
          });
        }
        return res.status(400).send({
          success: false,
          message: "User not added",
        });
      } catch (error) {
        console.error(error);
        return res.status(500).send({
          success: false,
          message: "Internal server error",
        });
      }
    });

    // ============== Create companies collection ==============
    app.post("/companies", async (req, res) => {
      try {
        const dataBody = req.body;

        // validation
        if (!dataBody?.companyName?.trim()) {
          return res.status(400).send({
            success: false,
            message: "Company name is required",
          });
        }

        const companyName = dataBody.companyName.trim().toLowerCase();

        // duplicate check
        // const existingCompany = await companies.findOne({ companyName });

        // if (existingCompany) {
        //   return res.status(200).send({
        //     success: true,
        //     message: "Company already exists",
        //     insertedId: existingCompany._id,
        //     existing: true,
        //   });
        // }

        const newCompany = {
          ...dataBody,
          companyName,
          status: "active",
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        const result = await companies.insertOne(newCompany);

        if (result.acknowledged) {
          return res.status(201).send({
            success: true,
            message: "Company added successfully",
            insertedId: result.insertedId,
            existing: false,
          });
        }

        return res.status(400).send({
          success: false,
          message: "Company not added",
        });
      } catch (error) {
        console.error(error);

        return res.status(500).send({
          success: false,
          message: "Internal server error",
        });
      }
    });

    // ============== Get companies collection ==============
    app.get("/companies", async (req, res) => {
      const result = await companies
        .find(
          {},
          {
            projection: {
              companyName: 1,
              companyLogo: 1,
              status: 1,
            },
          },
        )
        .toArray();

      res.send(result);
    });

    // ================ Get user info ===============
    app.get("/users/me", verifyFirebaseToken, async (req, res) => {
      const email = req.user.email;

      const user = await users.findOne({ email });

      if (!user) {
        return res.status(404).send({
          success: false,
          message: "User not found",
        });
      }
      res.send({
        success: true,
        user,
      });
    });

    // ================ UPDATE MY PROFILE ===============
    app.patch("/users/me", verifyFirebaseToken, async (req, res) => {
      try {
        const email = req.user.email;
        const updateDoc = {};

        const { displayName, phone, location, language, timezone, photoURL } =
          req.body;

        if (typeof displayName === "string" && displayName.trim()) {
          updateDoc.displayName = displayName.trim();
        }

        if (typeof phone === "string" && phone.trim()) {
          updateDoc.phone = phone.trim();
        }

        if (typeof location === "string" && location.trim()) {
          updateDoc.location = location.trim();
        }

        if (typeof language === "string" && language.trim()) {
          updateDoc.language = language.trim();
        }

        if (typeof timezone === "string" && timezone.trim()) {
          updateDoc.timezone = timezone.trim();
        }

        if (typeof photoURL === "string" && photoURL.trim()) {
          updateDoc.photoURL = photoURL.trim();
        }

        // No valid field found
        if (Object.keys(updateDoc).length === 0) {
          return res.status(400).send({
            success: false,
            message: "No valid data provided",
          });
        }

        updateDoc.updatedAt = new Date();

        const result = await users.updateOne(
          { email },
          {
            $set: updateDoc,
          },
        );

        // ======== create notification ============
        if (result.modifiedCount > 0) {
          try {
            await createNotification({
              uid: req.user.uid,
              userEmail: email,
              title: "Profile Updated",
              message:
                "Your profile information has been updated successfully.",
              type: "profile_updated",
              path: "/profile",
            });
          } catch (notifyErr) {
            console.error("Profile notification error:", notifyErr.message);
          }
        }
        // =========================================

        return res.send({
          success: true,
          message: "Profile updated successfully",
          modifiedCount: result.modifiedCount,
        });
      } catch (error) {
        return res.status(500).send({
          success: false,
          message: error.message,
        });
      }
    });

    // ---------------------------------------------- CREATE TICKET -------------------------------------------------
    app.post("/tickets", verifyFirebaseToken, async (req, res) => {
      try {
        const { ticketData, aiResult, resolutionType } = req.body;

        if (!ticketData || !aiResult || !resolutionType) {
          return res.status(400).send({
            success: false,
            message: "Required fields missing",
          });
        }

        if (!["ai", "human"].includes(resolutionType)) {
          return res.status(400).send({
            success: false,
            message: "Invalid resolution type",
          });
        }

        const user = await users.findOne({
          uid: req.user.uid,
        });

        if (!user) {
          return res.status(404).send({
            success: false,
            message: "User not found",
          });
        }

        if (user.role !== "customer") {
          return res.status(403).send({
            success: false,
            message: "Only customers can create tickets",
          });
        }

        if (!user.companyId || !ObjectId.isValid(user.companyId)) {
          return res.status(400).send({
            success: false,
            message: "User is not connected to any company",
          });
        }

        const now = new Date();
        const ticketNumber = generateTicketNumber();

        const isAiResolved = resolutionType === "ai";

        const ticket = {
          supportMode: isAiResolved ? "ai" : "human",
          resolutionSource: isAiResolved ? "ai" : null,
          aiResolved: isAiResolved,
          escalatedToHuman: !isAiResolved,

          ticketData,
          aiResult,

          uid: user.uid,
          ticketNumber,
          companyId: new ObjectId(user.companyId),

          status: isAiResolved ? "resolved" : "open",

          currentAgent: null,
          resolvedBy: null,
          resolvedAt: isAiResolved ? now : null,

          actionHistory: [
            {
              uid: user.uid,
              role: "customer",
              action: "created",
              date: now,
            },
            ...(isAiResolved
              ? [
                  {
                    uid: user.uid,
                    role: "customer",
                    action: "ai_resolved",
                    date: now,
                  },
                ]
              : []),
          ],

          createdAt: now,
          updatedAt: now,
        };

        const result = await tickets.insertOne(ticket);

        try {
          await createNotification({
            uid: user.uid,
            userEmail: user.email,
            title: isAiResolved
              ? "Ticket Resolved by AI"
              : "Ticket Created Successfully",
            message: isAiResolved
              ? `Your ticket ${ticketNumber} has been resolved by AI.`
              : `Your ticket ${ticketNumber} has been created. Our team will review it shortly.`,
            type: isAiResolved ? "ticket_resolved" : "ticket_created",
            ticketId: result.insertedId,
            ticketNumber,
            path: "/customer/my-tickets",
          });
        } catch (notificationError) {
          console.error(
            "Ticket notification error:",
            notificationError.message,
          );
        }

        return res.status(201).send({
          success: true,
          message: isAiResolved
            ? "Ticket resolved by AI"
            : "Ticket created successfully",
          id: result.insertedId,
          ticketNumber,
        });
      } catch (error) {
        console.error("CREATE TICKET ERROR:", error);

        return res.status(500).send({
          success: false,
          message: "Failed to create ticket",
        });
      }
    });

    // --------------------------------------------- GET MY TICKETS -------------------------------------------------
    app.get("/tickets/my-tickets", verifyFirebaseToken, async (req, res) => {
      try {
        const {
          search,
          status,
          priority,
          category,
          page = 1,
          limit = 10,
        } = req.query;

        const currentUser = await users.findOne({
          uid: req.user.uid,
        });

        if (!currentUser) {
          return res.status(404).send({
            success: false,
            message: "User not found",
          });
        }

        if (currentUser.role !== "customer") {
          return res.status(403).send({
            success: false,
            message: "Only customers can access their tickets",
          });
        }

        const queryData = {
          uid: currentUser.uid,
        };

        if (search) {
          queryData.$or = [
            {
              ticketNumber: {
                $regex: search,
                $options: "i",
              },
            },
            {
              "aiResult.ticketTitle": {
                $regex: search,
                $options: "i",
              },
            },
            {
              "aiResult.summary": {
                $regex: search,
                $options: "i",
              },
            },
          ];
        }

        if (status) {
          queryData.status = {
            $regex: new RegExp(`^${status}$`, "i"),
          };
        }

        if (category) {
          queryData["aiResult.category"] = {
            $regex: new RegExp(`^${category}$`, "i"),
          };
        }

        if (priority) {
          queryData["aiResult.states"] = {
            $elemMatch: {
              title: {
                $regex: /^priority$/i,
              },
              value: {
                $regex: new RegExp(`^${priority}$`, "i"),
              },
            },
          };
        }

        const pageNumber = Math.max(Number(page) || 1, 1);
        const limitNumber = Math.min(Math.max(Number(limit) || 10, 1), 100);
        const skip = (pageNumber - 1) * limitNumber;

        const total = await tickets.countDocuments(queryData);

        const result = await tickets
          .aggregate([
            {
              $match: queryData,
            },
            {
              $lookup: {
                from: "users",
                localField: "currentAgent.uid",
                foreignField: "uid",
                as: "currentAgentUser",
              },
            },
            {
              $lookup: {
                from: "users",
                localField: "resolvedBy.uid",
                foreignField: "uid",
                as: "resolvedByUser",
              },
            },
            {
              $sort: {
                updatedAt: -1,
                createdAt: -1,
              },
            },
            {
              $skip: skip,
            },
            {
              $limit: limitNumber,
            },
            {
              $project: {
                _id: 1,
                uid: 1,
                companyId: 1,
                ticketNumber: 1,

                status: 1,
                supportMode: 1,
                aiResolved: 1,
                escalatedToHuman: 1,
                resolutionSource: 1,

                createdAt: 1,
                updatedAt: 1,
                resolvedAt: 1,
                reopenedAt: 1,
                closedAt: 1,

                currentAgent: 1,
                resolvedBy: 1,
                actionHistory: 1,

                "aiResult.category": 1,
                "aiResult.states": 1,
                "aiResult.summary": 1,
                "aiResult.ticketTitle": 1,

                currentAgentInfo: {
                  $let: {
                    vars: {
                      agent: {
                        $arrayElemAt: ["$currentAgentUser", 0],
                      },
                    },
                    in: {
                      uid: "$$agent.uid",
                      displayName: "$$agent.displayName",
                      name: "$$agent.name",
                      email: "$$agent.email",
                      photoURL: "$$agent.photoURL",
                      role: "$$agent.role",
                      status: "$$agent.status",
                    },
                  },
                },

                resolvedByInfo: {
                  $let: {
                    vars: {
                      agent: {
                        $arrayElemAt: ["$resolvedByUser", 0],
                      },
                    },
                    in: {
                      uid: "$$agent.uid",
                      displayName: "$$agent.displayName",
                      name: "$$agent.name",
                      email: "$$agent.email",
                      photoURL: "$$agent.photoURL",
                      role: "$$agent.role",
                      status: "$$agent.status",
                    },
                  },
                },
              },
            },
          ])
          .toArray();

        const finalResult = result.map((ticket) => {
          const canReadMessages =
            ticket.aiResolved !== true &&
            ["assigned", "in_progress", "resolved", "closed"].includes(
              ticket.status,
            );

          const canSendMessage =
            ticket.aiResolved !== true &&
            ["assigned", "in_progress"].includes(ticket.status);

          const canClose = ticket.status === "resolved";

          const canReopen = ticket.status === "resolved";

          const canDelete =
            ticket.status === "open" &&
            ticket.aiResolved !== true &&
            !ticket.currentAgent?.uid &&
            !ticket.resolvedBy?.uid &&
            !ticket.actionHistory?.some(
              (item) =>
                item.role === "agent" ||
                ["ai_resolved", "reopened", "closed"].includes(item.action),
            );

          return {
            ...ticket,

            currentAgentInfo: ticket.currentAgentInfo?.uid
              ? {
                  uid: ticket.currentAgentInfo.uid,
                  displayName:
                    ticket.currentAgentInfo.displayName ||
                    ticket.currentAgentInfo.name ||
                    null,
                  email: ticket.currentAgentInfo.email || null,
                  photoURL: ticket.currentAgentInfo.photoURL || null,
                  role: ticket.currentAgentInfo.role || "agent",
                  status: ticket.currentAgentInfo.status || null,
                }
              : null,

            resolvedByInfo: ticket.resolvedByInfo?.uid
              ? {
                  uid: ticket.resolvedByInfo.uid,
                  displayName:
                    ticket.resolvedByInfo.displayName ||
                    ticket.resolvedByInfo.name ||
                    null,
                  email: ticket.resolvedByInfo.email || null,
                  photoURL: ticket.resolvedByInfo.photoURL || null,
                  role: ticket.resolvedByInfo.role || "agent",
                  status: ticket.resolvedByInfo.status || null,
                }
              : null,

            permission: {
              canRead: true,
              canReadMessages,
              canSendMessage,
              canClose,
              canReopen,
              canDelete,
            },
          };
        });

        return res.send({
          success: true,
          data: finalResult,
          pagination: {
            total,
            page: pageNumber,
            limit: limitNumber,
            totalPages: Math.ceil(total / limitNumber),
          },
        });
      } catch (error) {
        console.error("GET MY TICKETS ERROR:", error);

        return res.status(500).send({
          success: false,
          message: "Failed to fetch your tickets",
        });
      }
    });

    // ==============================================================================================================
    // ============================================ CUSTOMER RELATED ================================================
    // ==============================================================================================================

    //-------------------------------------------- CUSTOMER DASHBOARD -----------------------------------------------
    app.get(
      "/dashboard/customer-overview",
      verifyFirebaseToken,
      async (req, res) => {
        try {
          const uid = req.user.uid;

          const currentUser = await users.findOne({
            uid,
          });

          if (!currentUser) {
            return res.status(404).send({
              success: false,
              message: "User not found",
            });
          }

          if (currentUser.role !== "customer") {
            return res.status(403).send({
              success: false,
              message: "Only customers can access this dashboard",
            });
          }

          const ticketQuery = {
            uid,
          };

          const totalTickets = await tickets.countDocuments(ticketQuery);

          const openTickets = await tickets.countDocuments({
            ...ticketQuery,
            status: "open",
          });

          const assignedTickets = await tickets.countDocuments({
            ...ticketQuery,
            status: "assigned",
          });

          const inProgressTickets = await tickets.countDocuments({
            ...ticketQuery,
            status: "in_progress",
          });

          const resolvedTickets = await tickets.countDocuments({
            ...ticketQuery,
            status: "resolved",
          });

          const closedTickets = await tickets.countDocuments({
            ...ticketQuery,
            status: "closed",
          });

          const aiResolved = await tickets.countDocuments({
            ...ticketQuery,
            aiResolved: true,
          });

          const statusAggregation = await tickets
            .aggregate([
              {
                $match: ticketQuery,
              },
              {
                $group: {
                  _id: {
                    $toLower: "$status",
                  },
                  count: {
                    $sum: 1,
                  },
                },
              },
            ])
            .toArray();

          const statusChart = {
            open: 0,
            assigned: 0,
            in_progress: 0,
            resolved: 0,
            closed: 0,
          };

          statusAggregation.forEach((item) => {
            if (item._id && item._id in statusChart) {
              statusChart[item._id] = item.count;
            }
          });

          const now = new Date();

          const twelveMonthsAgo = new Date(
            now.getFullYear(),
            now.getMonth() - 11,
            1,
          );

          const activityAggregation = await tickets
            .aggregate([
              {
                $match: {
                  ...ticketQuery,
                  createdAt: {
                    $gte: twelveMonthsAgo,
                  },
                },
              },
              {
                $group: {
                  _id: {
                    $dateToString: {
                      format: "%Y-%m",
                      date: "$createdAt",
                    },
                  },
                  count: {
                    $sum: 1,
                  },
                },
              },
              {
                $sort: {
                  _id: 1,
                },
              },
            ])
            .toArray();

          const activityChart = [];

          for (let i = 11; i >= 0; i--) {
            const date = new Date(now.getFullYear(), now.getMonth() - i, 1);

            const monthString = `${date.getFullYear()}-${String(
              date.getMonth() + 1,
            ).padStart(2, "0")}`;

            const found = activityAggregation.find(
              (item) => item._id === monthString,
            );

            activityChart.push({
              month: date.toLocaleDateString("en-US", {
                month: "short",
              }),
              count: found?.count || 0,
            });
          }

          const recentTickets = await tickets
            .find(ticketQuery)
            .sort({
              updatedAt: -1,
              createdAt: -1,
            })
            .limit(5)
            .project({
              _id: 1,
              ticketNumber: 1,
              status: 1,
              supportMode: 1,
              aiResolved: 1,
              escalatedToHuman: 1,
              resolutionSource: 1,
              updatedAt: 1,
              createdAt: 1,
              "aiResult.ticketTitle": 1,
              "aiResult.states": 1,
              "aiResult.summary": 1,
              "aiResult.category": 1,
            })
            .toArray();

          const resolvedOrClosedTickets = resolvedTickets + closedTickets;

          const resolutionRate =
            totalTickets > 0
              ? Math.round((resolvedOrClosedTickets / totalTickets) * 100)
              : 0;

          return res.send({
            success: true,

            metrics: {
              totalTickets,
              openTickets,
              assignedTickets,
              inProgressTickets,
              resolvedTickets,
              closedTickets,
              aiResolved,
            },

            statusChart,
            activityChart,
            recentTickets,

            insights: {
              resolutionRate,
              aiResolved,
            },
          });
        } catch (error) {
          console.error("CUSTOMER DASHBOARD ERROR:", error);

          return res.status(500).send({
            success: false,
            message: "Failed to load customer dashboard",
          });
        }
      },
    );

    //-------------------------------------------- GET SINGLE TICKET -----------------------------------------------
    app.get("/tickets/:ticketId", verifyFirebaseToken, async (req, res) => {
      try {
        const { ticketId } = req.params;

        if (!ObjectId.isValid(ticketId)) {
          return res.status(400).send({
            success: false,
            message: "Invalid ticket ID",
          });
        }

        const currentUser = await users.findOne({
          uid: req.user.uid,
        });

        if (!currentUser) {
          return res.status(404).send({
            success: false,
            message: "User not found",
          });
        }

        const ticket = await tickets.findOne({
          _id: new ObjectId(ticketId),
        });

        if (!ticket) {
          return res.status(404).send({
            success: false,
            message: "Ticket not found",
          });
        }

        const isOwnerOrAdmin = ["owner", "admin"].includes(currentUser.role);
        const isCustomer = currentUser.role === "customer";
        const isAgent = currentUser.role === "agent";

        const isTicketOwner = isCustomer && ticket.uid === currentUser.uid;

        const sameCompany =
          currentUser.companyId &&
          ticket.companyId &&
          String(currentUser.companyId) === String(ticket.companyId);

        const isCurrentAgent =
          isAgent && ticket.currentAgent?.uid === currentUser.uid;

        const customerChatReadStatuses = [
          "assigned",
          "in_progress",
          "resolved",
          "closed",
        ];

        const agentChatReadStatuses = [
          "assigned",
          "in_progress",
          "resolved",
          "closed",
        ];

        let canRead = false;

        if (isOwnerOrAdmin) {
          canRead = true;
        } else if (isTicketOwner) {
          canRead = true;
        } else if (isAgent && sameCompany) {
          if (ticket.aiResolved === true) {
            canRead = true;
          } else if (ticket.status === "open" && !ticket.currentAgent?.uid) {
            canRead = true;
          } else if (
            isCurrentAgent &&
            agentChatReadStatuses.includes(ticket.status)
          ) {
            canRead = true;
          }
        }

        if (!canRead) {
          return res.status(403).send({
            success: false,
            message: "You are not allowed to view this ticket",
          });
        }

        let canReadMessages = false;

        if (isOwnerOrAdmin) {
          canReadMessages = true;
        } else if (
          isTicketOwner &&
          ticket.aiResolved !== true &&
          customerChatReadStatuses.includes(ticket.status)
        ) {
          canReadMessages = true;
        } else if (
          isAgent &&
          sameCompany &&
          isCurrentAgent &&
          ticket.aiResolved !== true &&
          agentChatReadStatuses.includes(ticket.status)
        ) {
          canReadMessages = true;
        }

        const canCustomerSendMessage =
          isTicketOwner &&
          ticket.aiResolved !== true &&
          ["assigned", "in_progress"].includes(ticket.status);

        const canAgentSendMessage =
          isCurrentAgent &&
          ticket.aiResolved !== true &&
          ["assigned", "in_progress"].includes(ticket.status);

        const canSendMessage = canCustomerSendMessage || canAgentSendMessage;

        const canAssign =
          isAgent &&
          sameCompany &&
          ticket.aiResolved !== true &&
          ticket.status === "open" &&
          !ticket.currentAgent?.uid;

        const canSuggestReply =
          isCurrentAgent &&
          ticket.aiResolved !== true &&
          ["assigned", "in_progress"].includes(ticket.status);

        const canRelease =
          isCurrentAgent &&
          ticket.aiResolved !== true &&
          ["assigned", "in_progress"].includes(ticket.status);

        const canResolve =
          isCurrentAgent &&
          ticket.aiResolved !== true &&
          ["assigned", "in_progress"].includes(ticket.status);

        const canClose = isTicketOwner && ticket.status === "resolved";

        const canReopen = isTicketOwner && ticket.status === "resolved";

        let customerInfo = null;

        if (ticket.uid) {
          const customer = await users.findOne(
            {
              uid: ticket.uid,
            },
            {
              projection: {
                _id: 0,
                uid: 1,
                displayName: 1,
                name: 1,
                email: 1,
                photoURL: 1,
                role: 1,
                status: 1,
                companyId: 1,
              },
            },
          );

          if (customer) {
            let companyName = null;

            if (customer.companyId) {
              try {
                let customerCompanyId = customer.companyId;

                if (
                  typeof customerCompanyId === "string" &&
                  ObjectId.isValid(customerCompanyId)
                ) {
                  customerCompanyId = new ObjectId(customerCompanyId);
                }

                const company = await companies.findOne(
                  {
                    _id: customerCompanyId,
                  },
                  {
                    projection: {
                      _id: 0,
                      companyName: 1,
                    },
                  },
                );

                companyName = company?.companyName || null;
              } catch {
                companyName = null;
              }
            }

            customerInfo = {
              uid: customer.uid || null,
              displayName: customer.displayName || customer.name || null,
              email: customer.email || null,
              photoURL: customer.photoURL || null,
              role: customer.role || "customer",
              status: customer.status || null,
              companyName,
            };
          }
        }

        let agentInfo = null;

        if (ticket.currentAgent?.uid) {
          const agent = await users.findOne(
            {
              uid: ticket.currentAgent.uid,
            },
            {
              projection: {
                _id: 0,
                uid: 1,
                displayName: 1,
                name: 1,
                email: 1,
                photoURL: 1,
                role: 1,
                status: 1,
              },
            },
          );

          if (agent) {
            agentInfo = {
              uid: agent.uid,
              displayName: agent.displayName || agent.name || "Agent",
              email: agent.email || null,
              photoURL: agent.photoURL || null,
              role: agent.role || "agent",
              status: agent.status || null,
              updatedAt: ticket.currentAgent.updatedAt || null,
            };
          }
        }

        let resolvedByInfo = null;

        if (ticket.resolvedBy?.uid) {
          const resolvedAgent = await users.findOne(
            {
              uid: ticket.resolvedBy.uid,
            },
            {
              projection: {
                _id: 0,
                uid: 1,
                displayName: 1,
                name: 1,
                email: 1,
                photoURL: 1,
                role: 1,
                status: 1,
              },
            },
          );

          if (resolvedAgent) {
            resolvedByInfo = {
              uid: resolvedAgent.uid,
              displayName:
                resolvedAgent.displayName || resolvedAgent.name || "Agent",
              email: resolvedAgent.email || null,
              photoURL: resolvedAgent.photoURL || null,
              role: resolvedAgent.role || "agent",
              status: resolvedAgent.status || null,
              updatedAt: ticket.resolvedBy.updatedAt || null,
            };
          }
        }

        return res.send({
          success: true,
          data: {
            ...ticket,
            customerInfo,
            agentInfo,
            resolvedByInfo,
            permission: {
              canRead,
              canReadMessages,
              canSendMessage,
              canSuggestReply,
              canRelease,
              canResolve,
              canAssign,
              canClose,
              canReopen,
              isCurrentAgent,
            },
          },
        });
      } catch (error) {
        console.error("GET /tickets/:ticketId ERROR:", error);

        return res.status(500).send({
          success: false,
          message: "Failed to get ticket",
        });
      }
    });

    // ------------------------------------------ DELETE SINGLE TICKET ----------------------------------------------
    app.delete("/tickets/:ticketId", verifyFirebaseToken, async (req, res) => {
      try {
        const { ticketId } = req.params;

        if (!ObjectId.isValid(ticketId)) {
          return res.status(400).send({
            success: false,
            message: "Invalid ticket ID",
          });
        }

        const currentUser = await users.findOne({
          uid: req.user.uid,
        });

        if (!currentUser) {
          return res.status(404).send({
            success: false,
            message: "User not found",
          });
        }

        const ticket = await tickets.findOne({
          _id: new ObjectId(ticketId),
        });

        if (!ticket) {
          return res.status(404).send({
            success: false,
            message: "Ticket not found",
          });
        }

        const ticketObjectId = new ObjectId(ticketId);

        if (["owner", "admin"].includes(currentUser.role)) {
          const result = await tickets.deleteOne({
            _id: ticketObjectId,
          });

          if (result.deletedCount === 0) {
            return res.status(400).send({
              success: false,
              message: "Ticket delete failed",
            });
          }

          return res.send({
            success: true,
            message: "Ticket deleted successfully",
          });
        }

        const isTicketOwner =
          currentUser.role === "customer" && ticket.uid === currentUser.uid;

        if (!isTicketOwner) {
          return res.status(403).send({
            success: false,
            message: "You don't have permission to delete this ticket",
          });
        }

        const hasSupportHistory = ticket.actionHistory?.some(
          (item) =>
            item.role === "agent" ||
            ["ai_resolved", "reopened", "closed"].includes(item.action),
        );

        if (
          ticket.status !== "open" ||
          ticket.currentAgent?.uid ||
          ticket.resolvedBy?.uid ||
          ticket.aiResolved === true ||
          hasSupportHistory
        ) {
          return res.status(400).send({
            success: false,
            message:
              "This ticket cannot be deleted because it has support history",
          });
        }

        const result = await tickets.deleteOne({
          _id: ticketObjectId,
          uid: currentUser.uid,
          status: "open",
          currentAgent: null,
          aiResolved: false,
        });

        if (result.deletedCount === 0) {
          return res.status(400).send({
            success: false,
            message: "Ticket delete failed",
          });
        }

        try {
          await createNotification({
            uid: ticket.uid,
            title: "Ticket Deleted",
            message: `Your ticket ${ticket.ticketNumber} has been deleted.`,
            type: "ticket_deleted",
            ticketNumber: ticket.ticketNumber,
            path: "/customer/my-tickets",
          });
        } catch (notifyErr) {
          console.error("Delete notification error:", notifyErr.message);
        }

        return res.send({
          success: true,
          message: "Ticket deleted successfully",
        });
      } catch (error) {
        console.error("DELETE TICKET ERROR:", error);

        return res.status(500).send({
          success: false,
          message: "Failed to delete ticket",
        });
      }
    });

    // ---------------------------------------- Update TICKET TO CLOSED ---------------------------------------------
    app.patch(
      "/tickets/:ticketId/close",
      verifyFirebaseToken,
      async (req, res) => {
        try {
          const { ticketId } = req.params;

          if (!ObjectId.isValid(ticketId)) {
            return res.status(400).send({
              success: false,
              message: "Invalid ticket ID",
            });
          }

          const currentUser = await users.findOne({
            uid: req.user.uid,
          });

          if (!currentUser) {
            return res.status(404).send({
              success: false,
              message: "User not found",
            });
          }

          if (currentUser.role !== "customer") {
            return res.status(403).send({
              success: false,
              message: "Only the customer can close this ticket",
            });
          }

          const ticketObjectId = new ObjectId(ticketId);

          const ticket = await tickets.findOne({
            _id: ticketObjectId,
          });

          if (!ticket) {
            return res.status(404).send({
              success: false,
              message: "Ticket not found",
            });
          }

          if (ticket.uid !== currentUser.uid) {
            return res.status(403).send({
              success: false,
              message: "You are not allowed to close this ticket",
            });
          }

          if (ticket.status !== "resolved") {
            return res.status(409).send({
              success: false,
              message: "Only resolved tickets can be closed",
            });
          }

          const now = new Date();

          const result = await tickets.updateOne(
            {
              _id: ticketObjectId,
              uid: currentUser.uid,
              status: "resolved",
            },
            {
              $set: {
                status: "closed",
                updatedAt: now,
                closedAt: now,
                closedBy: {
                  uid: currentUser.uid,
                  updatedAt: now,
                },
              },
              $push: {
                actionHistory: {
                  uid: currentUser.uid,
                  role: "customer",
                  action: "closed",
                  date: now,
                },
              },
            },
          );

          if (result.modifiedCount === 0) {
            return res.status(409).send({
              success: false,
              message: "Ticket status changed. Please refresh and try again.",
            });
          }

          return res.send({
            success: true,
            message: "Ticket closed successfully",
          });
        } catch (error) {
          console.error("CLOSE TICKET ERROR:", error);

          return res.status(500).send({
            success: false,
            message: "Failed to close ticket",
          });
        }
      },
    );

    // ---------------------------------------- UPDATE TICKET TO REOPEN ---------------------------------------------
    app.patch(
      "/tickets/:ticketId/reopen",
      verifyFirebaseToken,
      async (req, res) => {
        try {
          const { ticketId } = req.params;

          if (!ObjectId.isValid(ticketId)) {
            return res.status(400).send({
              success: false,
              message: "Invalid ticket ID",
            });
          }

          const currentUser = await users.findOne({
            uid: req.user.uid,
          });

          if (!currentUser) {
            return res.status(404).send({
              success: false,
              message: "User not found",
            });
          }

          if (currentUser.role !== "customer") {
            return res.status(403).send({
              success: false,
              message: "Only the customer can reopen this ticket",
            });
          }

          const ticketObjectId = new ObjectId(ticketId);

          const ticket = await tickets.findOne({
            _id: ticketObjectId,
          });

          if (!ticket) {
            return res.status(404).send({
              success: false,
              message: "Ticket not found",
            });
          }

          if (ticket.uid !== currentUser.uid) {
            return res.status(403).send({
              success: false,
              message: "You are not allowed to reopen this ticket",
            });
          }

          if (ticket.status !== "resolved") {
            return res.status(409).send({
              success: false,
              message: "Only resolved tickets can be reopened",
            });
          }

          const now = new Date();

          const result = await tickets.updateOne(
            {
              _id: ticketObjectId,
              uid: currentUser.uid,
              status: "resolved",
            },
            {
              $set: {
                status: "open",
                supportMode: "human",
                resolutionSource: null,
                aiResolved: false,
                escalatedToHuman: true,
                currentAgent: null,
                resolvedAt: null,
                updatedAt: now,
                reopenedAt: now,
              },
              $push: {
                actionHistory: {
                  uid: currentUser.uid,
                  role: "customer",
                  action: "reopened",
                  date: now,
                },
              },
            },
          );

          if (result.modifiedCount === 0) {
            return res.status(409).send({
              success: false,
              message: "Ticket status changed. Please refresh and try again.",
            });
          }

          return res.send({
            success: true,
            message: "Ticket reopened successfully",
          });
        } catch (error) {
          console.error("REOPEN TICKET ERROR:", error);

          return res.status(500).send({
            success: false,
            message: "Failed to reopen ticket",
          });
        }
      },
    );

    // ==============================================================================================================
    // =============================================== AGENT RELATED ================================================
    // ==============================================================================================================

    // ---------------------------------------------- AGENT DASHBOARD -----------------------------------------------
    app.get(
      "/dashboard/agent-overview",
      verifyFirebaseToken,
      verifyAgent,
      async (req, res) => {
        try {
          if (!req.agent.companyId || !ObjectId.isValid(req.agent.companyId)) {
            return res.status(400).send({
              success: false,
              message: "Agent company information is invalid",
            });
          }

          const agentUid = req.agent.uid;
          const companyId = new ObjectId(req.agent.companyId);

          const agentTicketFilter = {
            companyId,
            "currentAgent.uid": agentUid,
            aiResolved: false,
            status: {
              $in: ["assigned", "in_progress", "resolved"],
            },
          };

          const unassignedCondition = {
            $or: [
              { currentAgent: null },
              { currentAgent: { $exists: false } },
              { "currentAgent.uid": null },
              { "currentAgent.uid": { $exists: false } },
            ],
          };

          const todayStart = new Date();
          todayStart.setHours(0, 0, 0, 0);

          const [
            assignedToMe,
            openCompanyTickets,
            inProgressTickets,
            resolvedToday,
          ] = await Promise.all([
            tickets.countDocuments(agentTicketFilter),

            tickets.countDocuments({
              companyId,
              status: "open",
              aiResolved: false,
              ...unassignedCondition,
            }),

            tickets.countDocuments({
              companyId,
              "currentAgent.uid": agentUid,
              status: "in_progress",
            }),

            tickets.countDocuments({
              companyId,
              "resolvedBy.uid": agentUid,
              status: "resolved",
              resolvedAt: {
                $gte: todayStart,
              },
            }),
          ]);

          const statusResult = await tickets
            .aggregate([
              {
                $match: { companyId },
              },
              {
                $group: {
                  _id: { $toLower: "$status" },
                  count: { $sum: 1 },
                },
              },
            ])
            .toArray();

          const statusChart = {
            open: 0,
            assigned: 0,
            in_progress: 0,
            resolved: 0,
            closed: 0,
          };

          statusResult.forEach((item) => {
            if (item._id && item._id in statusChart) {
              statusChart[item._id] = item.count;
            }
          });

          const priorityResult = await tickets
            .aggregate([
              {
                $match: { companyId },
              },
              {
                $unwind: "$aiResult.states",
              },
              {
                $match: {
                  "aiResult.states.title": {
                    $regex: /^priority$/i,
                  },
                },
              },
              {
                $group: {
                  _id: { $toLower: "$aiResult.states.value" },
                  count: { $sum: 1 },
                },
              },
            ])
            .toArray();

          const priorityChart = {
            low: 0,
            medium: 0,
            high: 0,
            critical: 0,
          };

          priorityResult.forEach((item) => {
            if (item._id && item._id in priorityChart) {
              priorityChart[item._id] = item.count;
            }
          });

          const recentTickets = await tickets
            .find(agentTicketFilter)
            .sort({
              updatedAt: -1,
              createdAt: -1,
            })
            .limit(5)
            .project({
              _id: 1,
              uid: 1,
              ticketNumber: 1,
              status: 1,
              supportMode: 1,
              aiResolved: 1,
              resolutionSource: 1,
              createdAt: 1,
              updatedAt: 1,
              currentAgent: 1,
              resolvedBy: 1,
              "aiResult.ticketTitle": 1,
              "aiResult.summary": 1,
              "aiResult.category": 1,
              "aiResult.states": 1,
            })
            .toArray();

          const urgentTickets = await tickets
            .aggregate([
              {
                $match: {
                  companyId,
                  status: "open",
                  aiResolved: false,
                  ...unassignedCondition,
                  "aiResult.states": {
                    $elemMatch: {
                      title: {
                        $regex: /^priority$/i,
                      },
                      value: {
                        $regex: /^(high|critical)$/i,
                      },
                    },
                  },
                },
              },
              {
                $lookup: {
                  from: "users",
                  localField: "uid",
                  foreignField: "uid",
                  as: "customerUser",
                },
              },
              {
                $addFields: {
                  userInfo: {
                    $arrayElemAt: ["$customerUser", 0],
                  },
                },
              },
              {
                $addFields: {
                  priorityInfo: {
                    $arrayElemAt: [
                      {
                        $filter: {
                          input: "$aiResult.states",
                          as: "state",
                          cond: {
                            $regexMatch: {
                              input: {
                                $toString: "$$state.title",
                              },
                              regex: "^priority$",
                              options: "i",
                            },
                          },
                        },
                      },
                      0,
                    ],
                  },
                },
              },
              {
                $addFields: {
                  priorityScore: {
                    $switch: {
                      branches: [
                        {
                          case: {
                            $regexMatch: {
                              input: {
                                $toString: "$priorityInfo.value",
                              },
                              regex: "^critical$",
                              options: "i",
                            },
                          },
                          then: 2,
                        },
                        {
                          case: {
                            $regexMatch: {
                              input: {
                                $toString: "$priorityInfo.value",
                              },
                              regex: "^high$",
                              options: "i",
                            },
                          },
                          then: 1,
                        },
                      ],
                      default: 0,
                    },
                  },
                },
              },
              {
                $sort: {
                  priorityScore: -1,
                  createdAt: -1,
                },
              },
              {
                $limit: 3,
              },
              {
                $project: {
                  _id: 1,
                  uid: 1,
                  companyId: 1,
                  ticketNumber: 1,
                  status: 1,
                  supportMode: 1,
                  aiResolved: 1,
                  resolutionSource: 1,
                  createdAt: 1,
                  updatedAt: 1,
                  currentAgent: 1,
                  "aiResult.ticketTitle": 1,
                  "aiResult.summary": 1,
                  "aiResult.category": 1,
                  "aiResult.states": 1,
                  priorityInfo: 1,
                  userInfo: {
                    uid: 1,
                    displayName: 1,
                    name: 1,
                    email: 1,
                    photoURL: 1,
                    role: 1,
                    status: 1,
                  },
                },
              },
            ])
            .toArray();

          const formattedUrgentTickets = urgentTickets.map((ticket) => ({
            ...ticket,
            userInfo: ticket.userInfo
              ? {
                  uid: ticket.userInfo.uid,
                  displayName:
                    ticket.userInfo.displayName || ticket.userInfo.name || null,
                  email: ticket.userInfo.email || null,
                  photoURL: ticket.userInfo.photoURL || null,
                  role: ticket.userInfo.role || "customer",
                  status: ticket.userInfo.status || null,
                }
              : null,
            email: ticket.userInfo?.email || null,
            customerName:
              ticket.userInfo?.displayName || ticket.userInfo?.name || null,
          }));

          return res.send({
            success: true,
            metrics: {
              assignedToMe,
              openCompanyTickets,
              inProgressTickets,
              resolvedToday,
            },
            statusChart,
            priorityChart,
            recentTickets,
            urgentTickets: formattedUrgentTickets,
          });
        } catch (error) {
          console.error("AGENT DASHBOARD ERROR:", error);

          return res.status(500).send({
            success: false,
            message: "Failed to load agent dashboard",
          });
        }
      },
    );

    // -------------------------------------------- GET COMPANY TICKETS ---------------------------------------------
    app.get(
      "/agent/company-tickets",
      verifyFirebaseToken,
      verifyAgent,
      async (req, res) => {
        try {
          const {
            search,
            status,
            priority,
            category,
            page = 1,
            limit = 10,
          } = req.query;

          if (!req.agent.companyId || !ObjectId.isValid(req.agent.companyId)) {
            return res.status(400).send({
              success: false,
              message: "Agent company information is invalid",
            });
          }

          const companyId = new ObjectId(req.agent.companyId);

          const pageNumber = Math.max(Number(page) || 1, 1);
          const limitNumber = Math.min(Math.max(Number(limit) || 10, 1), 100);
          const skip = (pageNumber - 1) * limitNumber;

          const match = {
            companyId,
          };

          if (status) {
            match.status = {
              $regex: new RegExp(`^${status}$`, "i"),
            };
          }

          if (category) {
            match["aiResult.category"] = {
              $regex: new RegExp(`^${category}$`, "i"),
            };
          }

          if (priority) {
            match["aiResult.states"] = {
              $elemMatch: {
                title: {
                  $regex: /^priority$/i,
                },
                value: {
                  $regex: new RegExp(`^${priority}$`, "i"),
                },
              },
            };
          }

          const searchMatch = search
            ? {
                $or: [
                  {
                    ticketNumber: {
                      $regex: search,
                      $options: "i",
                    },
                  },
                  {
                    "aiResult.ticketTitle": {
                      $regex: search,
                      $options: "i",
                    },
                  },
                  {
                    "aiResult.summary": {
                      $regex: search,
                      $options: "i",
                    },
                  },
                  {
                    "userInfo.email": {
                      $regex: search,
                      $options: "i",
                    },
                  },
                  {
                    "userInfo.displayName": {
                      $regex: search,
                      $options: "i",
                    },
                  },
                ],
              }
            : null;

          const pipeline = [
            {
              $match: match,
            },
            {
              $lookup: {
                from: "users",
                localField: "uid",
                foreignField: "uid",
                as: "customerUser",
              },
            },
            {
              $lookup: {
                from: "users",
                localField: "currentAgent.uid",
                foreignField: "uid",
                as: "agentUser",
              },
            },
            {
              $lookup: {
                from: "users",
                localField: "resolvedBy.uid",
                foreignField: "uid",
                as: "resolvedByUser",
              },
            },
            {
              $addFields: {
                userInfo: {
                  $arrayElemAt: ["$customerUser", 0],
                },
                agentUser: {
                  $arrayElemAt: ["$agentUser", 0],
                },
                resolvedByUser: {
                  $arrayElemAt: ["$resolvedByUser", 0],
                },
              },
            },
          ];

          if (searchMatch) {
            pipeline.push({
              $match: searchMatch,
            });
          }

          const countResult = await tickets
            .aggregate([
              ...pipeline,
              {
                $count: "total",
              },
            ])
            .toArray();

          const total = countResult[0]?.total || 0;

          const result = await tickets
            .aggregate([
              ...pipeline,
              {
                $sort: {
                  createdAt: -1,
                  _id: -1,
                },
              },
              {
                $skip: skip,
              },
              {
                $limit: limitNumber,
              },
              {
                $project: {
                  _id: 1,
                  uid: 1,
                  companyId: 1,
                  ticketNumber: 1,
                  status: 1,
                  supportMode: 1,
                  aiResolved: 1,
                  resolutionSource: 1,
                  createdAt: 1,
                  updatedAt: 1,
                  resolvedAt: 1,
                  currentAgent: 1,
                  resolvedBy: 1,

                  "aiResult.category": 1,
                  "aiResult.states": 1,
                  "aiResult.summary": 1,
                  "aiResult.ticketTitle": 1,

                  userInfo: 1,
                  agentUser: 1,
                  resolvedByUser: 1,
                },
              },
            ])
            .toArray();

          const finalResult = result.map((ticket) => ({
            ...ticket,

            agentInfo: ticket.agentUser
              ? {
                  uid: ticket.agentUser.uid,
                  displayName:
                    ticket.agentUser.displayName ||
                    ticket.agentUser.name ||
                    null,
                  email: ticket.agentUser.email || null,
                  photoURL: ticket.agentUser.photoURL || null,
                  role: ticket.agentUser.role || "agent",
                  status: ticket.agentUser.status || null,
                }
              : null,

            userInfo: ticket.userInfo
              ? {
                  uid: ticket.userInfo.uid,
                  displayName:
                    ticket.userInfo.displayName || ticket.userInfo.name || null,
                  email: ticket.userInfo.email || null,
                  photoURL: ticket.userInfo.photoURL || null,
                  role: ticket.userInfo.role || "customer",
                  status: ticket.userInfo.status || null,
                }
              : null,

            resolvedByInfo: ticket.resolvedByUser
              ? {
                  uid: ticket.resolvedByUser.uid,
                  displayName:
                    ticket.resolvedByUser.displayName ||
                    ticket.resolvedByUser.name ||
                    null,
                  email: ticket.resolvedByUser.email || null,
                  photoURL: ticket.resolvedByUser.photoURL || null,
                  role: ticket.resolvedByUser.role || "agent",
                  status: ticket.resolvedByUser.status || null,
                }
              : null,

            agentUser: undefined,
            resolvedByUser: undefined,
            customerUser: undefined,
          }));

          return res.send({
            success: true,
            data: finalResult,
            pagination: {
              total,
              page: pageNumber,
              limit: limitNumber,
              totalPages: Math.ceil(total / limitNumber),
            },
          });
        } catch (error) {
          console.error("GET COMPANY TICKETS ERROR:", error);

          return res.status(500).send({
            success: false,
            message: "Failed to fetch company tickets",
          });
        }
      },
    );

    // --------------------------------------- GET ASSIGNED TICKETS TO AGENT ----------------------------------------
    app.get(
      "/agent/assigned-tickets",
      verifyFirebaseToken,
      verifyAgent,
      async (req, res) => {
        try {
          const {
            search,
            status,
            priority,
            category,
            page = 1,
            limit = 10,
          } = req.query;

          if (!req.agent.companyId || !ObjectId.isValid(req.agent.companyId)) {
            return res.status(400).send({
              success: false,
              message: "Agent company information is invalid",
            });
          }

          const companyId = new ObjectId(req.agent.companyId);

          const pageNumber = Math.max(Number(page) || 1, 1);
          const limitNumber = Math.min(Math.max(Number(limit) || 10, 1), 100);
          const skip = (pageNumber - 1) * limitNumber;

          const match = {
            companyId,
            "currentAgent.uid": req.agent.uid,
            aiResolved: false,
            status: {
              $in: ["assigned", "in_progress", "resolved"],
            },
          };

          if (status) {
            match.status = {
              $regex: new RegExp(`^${status}$`, "i"),
            };
          }

          if (category) {
            match["aiResult.category"] = {
              $regex: new RegExp(`^${category}$`, "i"),
            };
          }

          if (priority) {
            match["aiResult.states"] = {
              $elemMatch: {
                title: {
                  $regex: /^priority$/i,
                },
                value: {
                  $regex: new RegExp(`^${priority}$`, "i"),
                },
              },
            };
          }

          const pipeline = [
            {
              $match: match,
            },
            {
              $lookup: {
                from: "users",
                localField: "uid",
                foreignField: "uid",
                as: "customerUser",
              },
            },
            {
              $addFields: {
                userInfo: {
                  $arrayElemAt: ["$customerUser", 0],
                },
              },
            },
          ];

          if (search) {
            pipeline.push({
              $match: {
                $or: [
                  {
                    ticketNumber: {
                      $regex: search,
                      $options: "i",
                    },
                  },
                  {
                    "aiResult.ticketTitle": {
                      $regex: search,
                      $options: "i",
                    },
                  },
                  {
                    "aiResult.summary": {
                      $regex: search,
                      $options: "i",
                    },
                  },
                  {
                    "userInfo.email": {
                      $regex: search,
                      $options: "i",
                    },
                  },
                  {
                    "userInfo.displayName": {
                      $regex: search,
                      $options: "i",
                    },
                  },
                ],
              },
            });
          }

          const countResult = await tickets
            .aggregate([
              ...pipeline,
              {
                $count: "total",
              },
            ])
            .toArray();

          const total = countResult[0]?.total || 0;

          const result = await tickets
            .aggregate([
              ...pipeline,
              {
                $sort: {
                  updatedAt: -1,
                  _id: -1,
                },
              },
              {
                $skip: skip,
              },
              {
                $limit: limitNumber,
              },
              {
                $project: {
                  _id: 1,
                  uid: 1,
                  companyId: 1,
                  ticketNumber: 1,
                  status: 1,
                  supportMode: 1,
                  aiResolved: 1,
                  resolutionSource: 1,
                  createdAt: 1,
                  updatedAt: 1,
                  resolvedAt: 1,
                  currentAgent: 1,
                  resolvedBy: 1,

                  "aiResult.category": 1,
                  "aiResult.states": 1,
                  "aiResult.summary": 1,
                  "aiResult.ticketTitle": 1,

                  userInfo: 1,
                },
              },
            ])
            .toArray();

          const finalResult = result.map((ticket) => ({
            ...ticket,

            userInfo: ticket.userInfo
              ? {
                  uid: ticket.userInfo.uid,
                  displayName: ticket.userInfo.displayName || null,
                  email: ticket.userInfo.email || null,
                  photoURL: ticket.userInfo.photoURL || null,
                  role: ticket.userInfo.role || "customer",
                  status: ticket.userInfo.status || null,
                }
              : null,

            agentInfo: {
              uid: req.agent.uid,
              displayName: req.agent.displayName || req.agent.name || "Agent",
              email: req.agent.email || null,
              photoURL: req.agent.photoURL || null,
              role: "agent",
            },
          }));

          return res.send({
            success: true,
            data: finalResult,
            pagination: {
              total,
              page: pageNumber,
              limit: limitNumber,
              totalPages: Math.ceil(total / limitNumber),
            },
          });
        } catch (error) {
          console.error("GET ASSIGNED TICKETS ERROR:", error);

          return res.status(500).send({
            success: false,
            message: "Failed to fetch assigned tickets",
          });
        }
      },
    );

    // --------------------------------------- UPDATE ASSIGN TICKET TO AGENT ----------------------------------------
    app.patch(
      "/agent/tickets/:id/assign",
      verifyFirebaseToken,
      verifyAgent,
      async (req, res) => {
        try {
          const { id } = req.params;

          if (!ObjectId.isValid(id)) {
            return res.status(400).send({
              success: false,
              message: "Invalid ticket id",
            });
          }

          if (!req.agent.companyId || !ObjectId.isValid(req.agent.companyId)) {
            return res.status(400).send({
              success: false,
              message: "Agent company information is invalid",
            });
          }

          const ticketId = new ObjectId(id);
          const companyId = new ObjectId(req.agent.companyId);
          const assignedAt = new Date();

          const result = await tickets.updateOne(
            {
              _id: ticketId,
              companyId,
              status: "open",
              currentAgent: null,
              aiResolved: false,
            },
            {
              $set: {
                status: "assigned",
                supportMode: "human",
                resolutionSource: null,
                aiResolved: false,
                escalatedToHuman: true,

                currentAgent: {
                  uid: req.agent.uid,
                  updatedAt: assignedAt,
                },

                updatedAt: assignedAt,
              },

              $push: {
                actionHistory: {
                  uid: req.agent.uid,
                  role: "agent",
                  action: "assigned",
                  date: assignedAt,
                },
              },
            },
          );

          if (result.modifiedCount === 0) {
            const ticket = await tickets.findOne({
              _id: ticketId,
              companyId,
            });

            if (!ticket) {
              return res.status(404).send({
                success: false,
                message: "Ticket not found",
              });
            }

            if (ticket.aiResolved === true) {
              return res.status(409).send({
                success: false,
                message: "AI-resolved tickets cannot be assigned",
              });
            }

            if (ticket.status !== "open") {
              return res.status(409).send({
                success: false,
                message: "This ticket is not open",
              });
            }

            if (ticket.currentAgent?.uid) {
              return res.status(409).send({
                success: false,
                message: "This ticket is already assigned to another agent",
              });
            }

            return res.status(409).send({
              success: false,
              message: "This ticket is not available for assignment",
            });
          }

          const updatedTicket = await tickets.findOne({
            _id: ticketId,
            companyId,
          });

          if (!updatedTicket) {
            return res.status(404).send({
              success: false,
              message: "Ticket not found after assignment",
            });
          }

          try {
            await createNotification({
              uid: updatedTicket.uid,
              title: "Ticket Assigned to Support Agent",
              message: `Your ticket ${updatedTicket.ticketNumber} has been assigned to a support agent.`,
              type: "ticket_assigned",
              ticketId: updatedTicket._id,
              ticketNumber: updatedTicket.ticketNumber,
              path: "/customer/my-tickets",
            });

            await createNotification({
              uid: req.agent.uid,
              title: "Ticket Assigned to You",
              message: `Ticket ${updatedTicket.ticketNumber} has been assigned to you.`,
              type: "ticket_assigned",
              ticketId: updatedTicket._id,
              ticketNumber: updatedTicket.ticketNumber,
              path: `/agent/tickets/${updatedTicket._id}`,
            });
          } catch (notificationError) {
            console.error(
              "Assignment notification error:",
              notificationError.message,
            );
          }

          return res.send({
            success: true,
            message: "Ticket assigned successfully",
            data: updatedTicket,
          });
        } catch (error) {
          console.error("ASSIGN TICKET ERROR:", error);

          return res.status(500).send({
            success: false,
            message: "Failed to assign ticket",
          });
        }
      },
    );

    // -------------------------------------- UPDATE RELEASE TICKET TO COMPANY --------------------------------------
    app.patch(
      "/agent/tickets/:id/release",
      verifyFirebaseToken,
      verifyAgent,
      async (req, res) => {
        try {
          const { id } = req.params;

          if (!ObjectId.isValid(id)) {
            return res.status(400).send({
              success: false,
              message: "Invalid ticket id",
            });
          }

          if (!req.agent.companyId || !ObjectId.isValid(req.agent.companyId)) {
            return res.status(400).send({
              success: false,
              message: "Agent company information is invalid",
            });
          }

          const ticketId = new ObjectId(id);
          const companyId = new ObjectId(req.agent.companyId);
          const releasedAt = new Date();

          const ticket = await tickets.findOne({
            _id: ticketId,
            companyId,
          });

          if (!ticket) {
            return res.status(404).send({
              success: false,
              message: "Ticket not found",
            });
          }

          if (ticket.currentAgent?.uid !== req.agent.uid) {
            return res.status(403).send({
              success: false,
              message: "You are not the current agent of this ticket",
            });
          }

          if (!["assigned", "in_progress"].includes(ticket.status)) {
            return res.status(409).send({
              success: false,
              message: "This ticket cannot be released in its current status",
            });
          }

          const result = await tickets.updateOne(
            {
              _id: ticketId,
              companyId,
              status: {
                $in: ["assigned", "in_progress"],
              },
              "currentAgent.uid": req.agent.uid,
            },
            {
              $set: {
                status: "open",
                supportMode: "human",
                resolutionSource: null,
                aiResolved: false,
                escalatedToHuman: true,
                currentAgent: null,
                updatedAt: releasedAt,
              },
              $push: {
                actionHistory: {
                  uid: req.agent.uid,
                  role: "agent",
                  action: "released",
                  date: releasedAt,
                },
              },
            },
          );

          if (result.modifiedCount === 0) {
            return res.status(409).send({
              success: false,
              message:
                "Ticket could not be released. It may have already been updated.",
            });
          }

          const updatedTicket = await tickets.findOne({
            _id: ticketId,
            companyId,
          });

          try {
            await createNotification({
              uid: updatedTicket.uid,
              title: "Ticket Returned to Support Queue",
              message: `Your ticket ${updatedTicket.ticketNumber} has been returned to the support queue.`,
              type: "ticket_released",
              ticketId: updatedTicket._id,
              ticketNumber: updatedTicket.ticketNumber,
              path: "/customer/my-tickets",
            });

            await createNotification({
              uid: req.agent.uid,
              title: "Ticket Returned to Queue",
              message: `You returned ticket ${updatedTicket.ticketNumber} to the company queue.`,
              type: "ticket_returned",
              ticketId: updatedTicket._id,
              ticketNumber: updatedTicket.ticketNumber,
              path: `/agent/tickets/${updatedTicket._id}`,
            });
          } catch (notificationError) {
            console.error(
              "Release notification error:",
              notificationError.message,
            );
          }

          return res.send({
            success: true,
            message: "Ticket returned to company queue successfully",
            data: updatedTicket,
          });
        } catch (error) {
          console.error("RELEASE TICKET ERROR:", error);

          return res.status(500).send({
            success: false,
            message: "Failed to release ticket",
          });
        }
      },
    );

    // -------------------------------------------- UPDATE RESOLVE TICKET -------------------------------------------
    app.patch(
      "/agent/tickets/:id/resolve",
      verifyFirebaseToken,
      verifyAgent,
      async (req, res) => {
        try {
          const { id } = req.params;

          if (!ObjectId.isValid(id)) {
            return res.status(400).send({
              success: false,
              message: "Invalid ticket id",
            });
          }

          if (!req.agent.companyId || !ObjectId.isValid(req.agent.companyId)) {
            return res.status(400).send({
              success: false,
              message: "Agent company information is invalid",
            });
          }

          const ticketId = new ObjectId(id);
          const companyId = new ObjectId(req.agent.companyId);
          const resolvedAt = new Date();

          const ticket = await tickets.findOne({
            _id: ticketId,
            companyId,
          });

          if (!ticket) {
            return res.status(404).send({
              success: false,
              message: "Ticket not found",
            });
          }

          if (ticket.currentAgent?.uid !== req.agent.uid) {
            return res.status(403).send({
              success: false,
              message: "You are not the current agent of this ticket",
            });
          }

          if (!["assigned", "in_progress"].includes(ticket.status)) {
            return res.status(409).send({
              success: false,
              message: "This ticket cannot be resolved in its current status",
            });
          }

          if (ticket.aiResolved === true) {
            return res.status(409).send({
              success: false,
              message: "AI-resolved ticket cannot be resolved by an agent",
            });
          }

          const result = await tickets.updateOne(
            {
              _id: ticketId,
              companyId,
              status: {
                $in: ["assigned", "in_progress"],
              },
              "currentAgent.uid": req.agent.uid,
              aiResolved: false,
            },
            {
              $set: {
                status: "resolved",
                supportMode: "human",
                resolutionSource: "agent",
                aiResolved: false,
                escalatedToHuman: true,
                resolvedAt,
                updatedAt: resolvedAt,

                currentAgent: {
                  uid: req.agent.uid,
                  updatedAt: resolvedAt,
                },

                resolvedBy: {
                  uid: req.agent.uid,
                  updatedAt: resolvedAt,
                },
              },
              $push: {
                actionHistory: {
                  uid: req.agent.uid,
                  role: "agent",
                  action: "resolved",
                  date: resolvedAt,
                },
              },
            },
          );

          if (result.modifiedCount === 0) {
            return res.status(409).send({
              success: false,
              message:
                "Ticket could not be resolved. It may have already been updated.",
            });
          }

          const updatedTicket = await tickets.findOne({
            _id: ticketId,
            companyId,
          });

          try {
            await createNotification({
              uid: updatedTicket.uid,
              title: "Ticket Resolved",
              message: `Your ticket ${updatedTicket.ticketNumber} has been resolved by our support team.`,
              type: "ticket_resolved",
              ticketId: updatedTicket._id,
              ticketNumber: updatedTicket.ticketNumber,
              path: "/customer/my-tickets",
            });

            await createNotification({
              uid: req.agent.uid,
              title: "Ticket Resolved",
              message: `You resolved ticket ${updatedTicket.ticketNumber}.`,
              type: "ticket_resolved",
              ticketId: updatedTicket._id,
              ticketNumber: updatedTicket.ticketNumber,
              path: `/agent/tickets/${updatedTicket._id}`,
            });
          } catch (notificationError) {
            console.error(
              "Resolve notification error:",
              notificationError.message,
            );
          }

          return res.send({
            success: true,
            message: "Ticket resolved successfully",
            data: updatedTicket,
          });
        } catch (error) {
          console.error("RESOLVE TICKET ERROR:", error);

          return res.status(500).send({
            success: false,
            message: "Failed to resolve ticket",
          });
        }
      },
    );

    // ------------------------------------------- GET SUPPORT CONVERSATION -----------------------------------------
    app.get(
      "/tickets/:ticketId/conversations",
      verifyFirebaseToken,
      async (req, res) => {
        try {
          const { ticketId } = req.params;

          if (!ObjectId.isValid(ticketId)) {
            return res.status(400).send({
              success: false,
              message: "Invalid ticket ID",
            });
          }

          const currentUser = await users.findOne({
            uid: req.user.uid,
          });

          if (!currentUser) {
            return res.status(404).send({
              success: false,
              message: "User not found",
            });
          }

          const ticket = await tickets.findOne({
            _id: new ObjectId(ticketId),
          });

          if (!ticket) {
            return res.status(404).send({
              success: false,
              message: "Ticket not found",
            });
          }

          const isOwnerOrAdmin = ["owner", "admin"].includes(currentUser.role);

          const isCustomer = currentUser.role === "customer";
          const isAgent = currentUser.role === "agent";

          const isTicketOwner = isCustomer && ticket.uid === currentUser.uid;

          const sameCompany =
            currentUser.companyId &&
            ticket.companyId &&
            String(currentUser.companyId) === String(ticket.companyId);

          const isCurrentAgent =
            isAgent && ticket.currentAgent?.uid === currentUser.uid;

          let canReadMessages = false;

          if (isOwnerOrAdmin) {
            canReadMessages = true;
          } else if (
            isTicketOwner &&
            ticket.aiResolved !== true &&
            ["assigned", "in_progress", "resolved", "closed"].includes(
              ticket.status,
            )
          ) {
            canReadMessages = true;
          } else if (
            isAgent &&
            sameCompany &&
            isCurrentAgent &&
            ticket.aiResolved !== true &&
            ["assigned", "in_progress", "resolved", "closed"].includes(
              ticket.status,
            )
          ) {
            canReadMessages = true;
          }

          if (!canReadMessages) {
            return res.status(403).send({
              success: false,
              message: "You are not allowed to view this conversation",
            });
          }

          const conversations = await supportConversations
            .find({
              ticketId: ticket._id,
            })
            .sort({
              createdAt: 1,
            })
            .toArray();

          return res.send({
            success: true,
            data: conversations,
          });
        } catch (error) {
          console.error("GET /tickets/:ticketId/conversations ERROR:", error);

          return res.status(500).send({
            success: false,
            message: "Failed to get conversations",
          });
        }
      },
    );

    // --------------------------------------------- SEND SUPPORT MESSAGE -------------------------------------------
    app.post(
      "/tickets/:ticketId/conversations",
      verifyFirebaseToken,
      async (req, res) => {
        try {
          const { ticketId } = req.params;
          const { message } = req.body;

          if (!ObjectId.isValid(ticketId)) {
            return res.status(400).send({
              success: false,
              message: "Invalid ticket id",
            });
          }

          if (typeof message !== "string" || !message.trim()) {
            return res.status(400).send({
              success: false,
              message: "Message is required",
            });
          }

          const currentUser = await users.findOne({
            uid: req.user.uid,
          });

          if (!currentUser) {
            return res.status(404).send({
              success: false,
              message: "User not found",
            });
          }

          if (!["customer", "agent"].includes(currentUser.role)) {
            return res.status(403).send({
              success: false,
              message: "You are not allowed to send messages",
            });
          }

          const ticketObjectId = new ObjectId(ticketId);

          const ticket = await tickets.findOne({
            _id: ticketObjectId,
          });

          if (!ticket) {
            return res.status(404).send({
              success: false,
              message: "Ticket not found",
            });
          }

          if (ticket.aiResolved === true) {
            return res.status(409).send({
              success: false,
              message:
                "This ticket was resolved by AI and does not support chat",
            });
          }

          const now = new Date();

          if (currentUser.role === "customer") {
            if (ticket.uid !== currentUser.uid) {
              return res.status(403).send({
                success: false,
                message: "You are not allowed to send messages",
              });
            }

            if (!["assigned", "in_progress"].includes(ticket.status)) {
              return res.status(409).send({
                success: false,
                message:
                  "You cannot send messages in the current ticket status",
              });
            }

            const updateResult = await tickets.updateOne(
              {
                _id: ticketObjectId,
                uid: currentUser.uid,
                status: {
                  $in: ["assigned", "in_progress"],
                },
                aiResolved: false,
              },
              {
                $set: {
                  updatedAt: now,
                },
              },
            );

            if (updateResult.modifiedCount === 0) {
              return res.status(409).send({
                success: false,
                message: "Ticket status changed. Please refresh and try again.",
              });
            }
          }

          if (currentUser.role === "agent") {
            if (
              !ticket.companyId ||
              !currentUser.companyId ||
              String(ticket.companyId) !== String(currentUser.companyId)
            ) {
              return res.status(403).send({
                success: false,
                message: "You are not allowed to access this ticket",
              });
            }

            if (ticket.currentAgent?.uid !== currentUser.uid) {
              return res.status(403).send({
                success: false,
                message: "Only the current agent can send messages",
              });
            }

            if (!["assigned", "in_progress"].includes(ticket.status)) {
              return res.status(409).send({
                success: false,
                message:
                  "You cannot send messages in the current ticket status",
              });
            }

            if (ticket.status === "assigned") {
              const updateResult = await tickets.updateOne(
                {
                  _id: ticketObjectId,
                  status: "assigned",
                  "currentAgent.uid": currentUser.uid,
                  aiResolved: false,
                },
                {
                  $set: {
                    status: "in_progress",
                    updatedAt: now,
                  },
                  $push: {
                    actionHistory: {
                      uid: currentUser.uid,
                      role: "agent",
                      action: "in_progress",
                      date: now,
                    },
                  },
                },
              );

              if (updateResult.modifiedCount === 0) {
                return res.status(409).send({
                  success: false,
                  message:
                    "Ticket status changed. Please refresh and try again.",
                });
              }
            } else {
              const updateResult = await tickets.updateOne(
                {
                  _id: ticketObjectId,
                  status: "in_progress",
                  "currentAgent.uid": currentUser.uid,
                  aiResolved: false,
                },
                {
                  $set: {
                    updatedAt: now,
                  },
                },
              );

              if (updateResult.modifiedCount === 0) {
                return res.status(409).send({
                  success: false,
                  message:
                    "Ticket status changed. Please refresh and try again.",
                });
              }
            }
          }

          const conversationMessage = {
            ticketId: ticketObjectId,
            ticketNumber: ticket.ticketNumber,

            sender: {
              uid: currentUser.uid,
              role: currentUser.role,
              displayName:
                currentUser.displayName ||
                currentUser.name ||
                currentUser.email ||
                "User",
              email: currentUser.email || null,
              photoURL: currentUser.photoURL || null,
            },

            message: message.trim(),
            type: "text",
            attachments: [],
            createdAt: now,
            updatedAt: now,
          };

          const result =
            await supportConversations.insertOne(conversationMessage);

          if (!result.acknowledged) {
            return res.status(500).send({
              success: false,
              message: "Message could not be sent",
            });
          }

          if (currentUser.role === "agent") {
            try {
              await createNotification({
                uid: ticket.uid,
                userEmail: ticket.email,
                title: "New Support Reply",
                message: `You received a new reply on ticket ${ticket.ticketNumber}.`,
                type: "agent_reply",
                ticketId: ticket._id,
                ticketNumber: ticket.ticketNumber,
                path: `/customer/tickets/${ticket._id}`,
              });
            } catch (notificationError) {
              console.error(
                "Agent reply notification error:",
                notificationError.message,
              );
            }
          }

          return res.status(201).send({
            success: true,
            message: "Message sent successfully",
            data: {
              ...conversationMessage,
              _id: result.insertedId,
            },
          });
        } catch (error) {
          console.error("SEND CONVERSATION MESSAGE ERROR:", error);

          return res.status(500).send({
            success: false,
            message: "Failed to send message",
          });
        }
      },
    );

    // ========================================== DELETE CONVERSATION MESSAGE =======================================
    // ==============================================================================================================
    //  ============================================ notification ===================================================
    app.get("/notifications", verifyFirebaseToken, async (req, res) => {
      try {
        const uid = req.user.uid;

        const limit = parseInt(req.query.limit) || 20;

        const data = await notifications
          .find({ uid })
          .sort({ createdAt: -1 })
          .limit(limit)
          .toArray();

        const unreadCount = await notifications.countDocuments({
          uid,
          isRead: false,
        });

        return res.send({
          success: true,
          unreadCount,
          notifications: data,
        });
      } catch (error) {
        return res.status(500).send({
          success: false,
          message: error.message,
        });
      }
    });

    // ============== PATCH /notifications/:id ====================
    app.patch("/notifications/:id", verifyFirebaseToken, async (req, res) => {
      try {
        const { id } = req.params;

        const result = await notifications.updateOne(
          {
            _id: new ObjectId(id),
            userEmail: req.user.email,
          },
          {
            $set: {
              isRead: true,
              readAt: new Date(),
            },
          },
        );

        return res.send({
          success: true,
          modifiedCount: result.modifiedCount,
        });
      } catch (error) {
        return res.status(500).send({
          success: false,
          message: error.message,
        });
      }
    });

    // ================ PATCH /notifications/read-all =================
    app.patch(
      "/notifications/read-all",
      verifyFirebaseToken,
      async (req, res) => {
        try {
          const result = await notifications.updateMany(
            {
              userEmail: req.user.email,
              isRead: false,
            },
            {
              $set: {
                isRead: true,
                readAt: new Date(),
              },
            },
          );

          return res.send({
            success: true,
            modifiedCount: result.modifiedCount,
          });
        } catch (error) {
          return res.status(500).send({
            success: false,
            message: error.message,
          });
        }
      },
    );

    // ================================================ AI ANALYZE TICKET ===========================================
    app.post("/ai/analyze-ticket", verifyFirebaseToken, async (req, res) => {
      try {
        const { description, attachments } = req.body;

        if (!description) {
          return res.status(400).send({
            success: false,
            message: "description is required",
          });
        }

        // console.log("index: ", attachments, description)

        const result = await analyzeTicket({
          description,
          // imageUrls: attachments,  // uncomment it after upgrading model
        });

        return res.status(200).send({
          success: true,
          data: result,
        });
      } catch (error) {
        console.error("AI error:", error.message);

        return res.status(500).send({
          success: false,
          message: error.message,
        });
      }
    });

    // ======================== AI CHAT-BOT ASSISTANT =============================
    app.post("/ai/chat", verifyFirebaseToken, async (req, res) => {
      try {
        const { message, conversationId = null } = req.body;
        const uid = req.user.uid;

        if (!message) {
          return res.status(400).send({
            success: false,
            message: "message is required",
          });
        }

        if (!uid) {
          return res.status(400).send({
            success: false,
            message: "Uid not found",
          });
        }

        const user = await users.findOne({ uid });

        if (!user) {
          return res.status(404).send({
            success: false,
            message: "User not found",
          });
        }
        const userContext = { user };
        let newConversationId = null;
        let isNewConversation = false;

        // ===== create or load conversation =====
        if (!conversationId) {
          const insertResult = await aiConversations.insertOne({
            uid: uid,
            preview: null,
            details: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
          newConversationId = insertResult.insertedId;
          isNewConversation = true;
        } else {
          if (!ObjectId.isValid(conversationId)) {
            return res.status(400).send({
              success: false,
              message: "Invalid conversationId",
            });
          }

          newConversationId = new ObjectId(conversationId);

          const findResult = await aiConversations.findOne({
            _id: newConversationId,
            uid: uid,
          });

          // fallback create
          if (!findResult) {
            const insertResult = await aiConversations.insertOne({
              uid: uid,
              preview: null,
              details: null,
              createdAt: new Date(),
              updatedAt: new Date(),
            });
            newConversationId = insertResult.insertedId;
            isNewConversation = true;
          }
        }

        // ===== fetch history =====
        const historyDocs = await aiMessages
          .find({ conversationId: newConversationId })
          .sort({ createdAt: 1 }) // ascending
          .limit(10)
          .toArray();

        const history = historyDocs.map((m) => ({
          role: m.sender === "ai" ? "assistant" : "user",
          content: m.message,
        }));
        // console.log(history);

        // ===== SAVE USER MESSAGE FIRST =====
        const userMessageDoc = {
          conversationId: newConversationId,
          sender: "user",
          message,
          createdAt: new Date(),
        };

        const userMessageResult = await aiMessages.insertOne(userMessageDoc);

        // ===== AI CALL =====
        const result = await chatWithAssistant({
          message,
          history,
          userContext,
        });

        // ===== SAVE AI MESSAGE =====
        const aiMessageDoc = {
          conversationId: newConversationId,
          sender: "ai",
          message: result.reply,
          meta: {
            mode: result.mode,
            intent: result.intent,
            severity: result.severity,
            tokensUsed: result.meta?.tokensUsed,
            model: result.meta?.model,
          },
          createdAt: new Date(),
        };

        const aiMessageResult = await aiMessages.insertOne(aiMessageDoc);

        // ===== update conversation after AI response =====
        if (isNewConversation) {
          await aiConversations.updateOne(
            { _id: newConversationId, uid: uid },
            {
              $set: {
                preview:
                  result.preview ||
                  result.reply?.slice(0, 60) ||
                  "New conversation",
                details:
                  result.details ||
                  result.reply?.slice(0, 120) ||
                  "AI conversation started",
                updatedAt: new Date(),
              },
            },
          );
        } else {
          await aiConversations.updateOne(
            { _id: newConversationId, uid: uid },
            {
              $set: {
                updatedAt: new Date(),
              },
            },
          );
        }

        // ==================
        return res.send({
          success: true,
          conversationId: newConversationId.toString(),
          data: result,
          messages: {
            user: {
              _id: userMessageResult.insertedId,
              ...userMessageDoc,
            },
            ai: {
              _id: aiMessageResult.insertedId,
              ...aiMessageDoc,
            },
          },
        });
      } catch (error) {
        console.error("AI Chat Error:", error);

        return res.status(500).send({
          success: false,
          message: error.message,
        });
      }
    });

    // ======================== GET AI CONVERSATION HISTORY =============================
    app.get("/ai/conversations", verifyFirebaseToken, async (req, res) => {
      try {
        const { search, page = 1, limit = 30 } = req.query;
        const uid = req.user.uid;

        if (!uid) {
          return res.status(400).send({
            success: false,
            message: "Uid not found",
          });
        }

        const query = {
          uid: uid,
        };

        // ===== search by preview/details =====
        if (search?.trim()) {
          query.$or = [
            {
              preview: {
                $regex: search.trim(),
                $options: "i",
              },
            },
            {
              details: {
                $regex: search.trim(),
                $options: "i",
              },
            },
          ];
        }

        const pageNumber = Number(page);
        const limitNumber = Number(limit);
        const skip = (pageNumber - 1) * limitNumber;

        const total = await aiConversations.countDocuments(query);

        const conversations = await aiConversations
          .find(query, {
            projection: {
              preview: 1,
              details: 1,
              updatedAt: 1,
            },
          })
          .sort({ updatedAt: -1 })
          .skip(skip)
          .limit(limitNumber)
          .toArray();

        return res.send({
          success: true,
          data: conversations,
          pagination: {
            total,
            page: pageNumber,
            limit: limitNumber,
            totalPages: Math.ceil(total / limitNumber),
          },
        });
      } catch (error) {
        console.error("Get AI conversations error:", error);

        return res.status(500).send({
          success: false,
          message: error.message,
        });
      }
    });

    // ======================== GET AI CONVERSATION MESSAGES ============================
    app.get(
      "/ai/conversations/:conversationId/messages",
      verifyFirebaseToken,
      async (req, res) => {
        try {
          const uid = req.user.uid;
          const { conversationId } = req.params;

          if (!uid) {
            return res.status(400).send({
              success: false,
              message: "Uid not found",
            });
          }

          if (!conversationId || !ObjectId.isValid(conversationId)) {
            return res.status(400).send({
              success: false,
              message: "Invalid conversationId",
            });
          }

          // for security check
          const conversation = await aiConversations.findOne({
            _id: new ObjectId(conversationId),
            uid: uid,
          });

          if (!conversation) {
            return res.status(404).send({
              success: false,
              message: "Conversation not found",
            });
          }

          const messages = await aiMessages
            .find({
              conversationId: new ObjectId(conversationId),
            })
            .sort({ createdAt: 1 })
            .toArray();

          return res.send({
            success: true,
            conversation,
            data: messages,
          });
        } catch (error) {
          console.error("Get AI messages error:", error);

          return res.status(500).send({
            success: false,
            message: error.message,
          });
        }
      },
    );

    // ==================================================================================
    // ======================== AI SUGGEST REPLY FOR AGENT =============================
    app.post(
      "/ai/suggest-reply",
      verifyFirebaseToken,
      verifyAgent,
      async (req, res) => {
        try {
          const { ticketId, agentDraft = "" } = req.body;

          if (!ticketId) {
            return res.status(400).send({
              success: false,
              message: "ticketId is required",
            });
          }

          if (!ObjectId.isValid(ticketId)) {
            return res.status(400).send({
              success: false,
              message: "Invalid ticket id",
            });
          }

          const ticket = await tickets.findOne({
            _id: new ObjectId(ticketId),
          });

          if (!ticket) {
            return res.status(404).send({
              success: false,
              message: "Ticket not found",
            });
          }

          if (
            !ticket.companyId ||
            ticket.companyId.toString() !== req.agent.companyId.toString()
          ) {
            return res.status(403).send({
              success: false,
              message: "You don't have permission to access this ticket",
            });
          }

          if (ticket.aiResolved === true) {
            return res.status(409).send({
              success: false,
              message: "AI-resolved tickets do not support agent replies",
            });
          }

          if (ticket.currentAgent?.uid !== req.agent.uid) {
            return res.status(403).send({
              success: false,
              message: "This ticket is assigned to another agent",
            });
          }

          if (!["assigned", "in_progress"].includes(ticket.status)) {
            return res.status(409).send({
              success: false,
              message: "AI suggested reply is unavailable for this ticket",
            });
          }

          const ticketContext = {
            ticketNumber: ticket.ticketNumber || null,
            status: ticket.status || null,
            supportMode: ticket.supportMode || null,
            resolutionSource: ticket.resolutionSource || null,
            description: ticket.ticketData?.description || null,
            aiAnalysis: {
              ticketTitle: ticket.aiResult?.ticketTitle || null,
              summary: ticket.aiResult?.summary || null,
              category: ticket.aiResult?.category || null,
              rootCause: ticket.aiResult?.rootCause || null,
              metrics: ticket.aiResult?.metrics || [],
              states: ticket.aiResult?.states || [],
              recommendations: ticket.aiResult?.recommendations || [],
              steps: ticket.aiResult?.steps || [],
              escalation: ticket.aiResult?.escalation || null,
            },
          };

          const customer = await users.findOne({
            uid: ticket.uid,
          });

          if (!customer) {
            return res.status(404).send({
              success: false,
              message: "Customer not found",
            });
          }

          let companyName = null;

          if (customer.companyId && ObjectId.isValid(customer.companyId)) {
            const company = await companies.findOne({
              _id: new ObjectId(customer.companyId),
            });

            companyName = company?.companyName || null;
          }

          const customerContext = {
            uid: customer.uid || null,
            displayName: customer.displayName || "Customer",
            email: customer.email || null,
            role: customer.role || "customer",
            companyName,
          };

          const agentContext = {
            uid: req.agent.uid,
            displayName: req.agent.displayName || "Support Agent",
            email: req.agent.email || null,
            role: "agent",
          };

          const conversationHistory = await supportConversations
            .find(
              {
                ticketId: new ObjectId(ticketId),
              },
              {
                projection: {
                  _id: 0,
                  "sender.uid": 1,
                  "sender.role": 1,
                  "sender.displayName": 1,
                  message: 1,
                  createdAt: 1,
                },
              },
            )
            .sort({
              createdAt: -1,
            })
            .limit(15)
            .toArray();

          conversationHistory.reverse();

          const result = await suggestAgentReply({
            ticketContext,
            customerContext,
            agentContext,
            conversationHistory,
            agentDraft: typeof agentDraft === "string" ? agentDraft.trim() : "",
          });

          return res.send({
            success: true,
            data: {
              reply: result.reply,
            },
            meta: result.meta,
          });
        } catch (error) {
          console.error("Suggest reply error:", error);

          return res.status(500).send({
            success: false,
            message: error.message || "Failed to generate suggested reply",
          });
        }
      },
    );

    // ==================================================================================
    // ==================================================================================
    // ==================================================================================
    // ==================================================================================

    app.patch(
      "/admin/agents/:id/approve",
      verifyFirebaseToken,
      async (req, res) => {
        try {
          const { id } = req.params;

          if (!ObjectId.isValid(id)) {
            return res.status(400).send({
              success: false,
              message: "Invalid agent id",
            });
          }

          const result = await users.updateOne(
            {
              _id: new ObjectId(id),
              role: "agent",
              verifyIdAgent: "pending",
            },
            {
              $set: {
                verifyIdAgent: "approved",
                status: "active",
                updatedAt: new Date(),
              },
            },
          );

          if (result.matchedCount === 0) {
            return res.status(404).send({
              success: false,
              message: "Pending agent not found",
            });
          }

          return res.send({
            success: true,
            message: "Agent approved successfully",
          });
        } catch (error) {
          return res.status(500).send({
            success: false,
            message: error.message,
          });
        }
      },
    );
    // fetch(`http://localhost:3021/admin/agents/${agentId}/approve`, {
    //   method: "PATCH",
    //   headers: {
    //     authorization: `Bearer ${token}`,
    //   },
    // });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.listen(port, () => {
  console.log(`SupportHub server listening on port ${port}`);
});
