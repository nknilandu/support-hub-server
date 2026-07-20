const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const app = express();
const port = process.env.PORT || 3021;
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const { analyzeTicket, chatWithAssistant } = require("./ai-agents");
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
      readAt,
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

    // ================= CREATE TICKET =================
    app.post("/tickets", verifyFirebaseToken, async (req, res) => {
      try {
        const bodyData = req.body;

        if (!bodyData?.uid || !bodyData?.email || !bodyData?.aiResult) {
          return res.status(400).send({
            success: false,
            message: "Required fields missing",
          });
        }
        // find user for companyId
        const user = await users.findOne({ uid: req.user.uid });
        if (!user) {
          return res.status(404).send({
            success: false,
            message: "User not found",
          });
        }
        if (!user.companyId || !ObjectId.isValid(user.companyId)) {
          return res.status(400).send({
            success: false,
            message: "User is not connected to any company",
          });
        }
        // generate ticket number
        const ticketNumber = generateTicketNumber();
        const ticket = {
          ...bodyData,
          ticketNumber: ticketNumber,
          companyId: new ObjectId(user.companyId),
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        const result = await tickets.insertOne(ticket);

        // ======== create notification ============
        try {
          await createNotification({
            uid: bodyData.uid,
            userEmail: bodyData.email,
            title: "Ticket Created Successfully",
            message: `Your ticket ${ticketNumber} has been created. Our team will review it shortly.`,
            type: "ticket_created",
            ticketId: result.insertedId,
            ticketNumber: ticketNumber,
            path: "/customer/my-tickets",
          });
        } catch (notifyErr) {
          console.error("Notification error:", notifyErr.message);
        }
        // ============
        return res.status(201).send({
          success: true,
          message: "Ticket created successfully",
          id: result.insertedId,
          ticketNumber: ticketNumber,
        });
      } catch (error) {
        return res.status(500).send({
          success: false,
          message: error.message,
        });
      }
    });

    // ================= GET MY TICKETS =================
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

        const query = {
          email: req.user.email,
        };

        // Search
        if (search) {
          query.$or = [
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
          ];
        }
        // Status
        if (status) {
          query.status = {
            $regex: new RegExp(`^${status}$`, "i"),
          };
        }
        // Category
        if (category) {
          query["aiResult.category"] = {
            $regex: new RegExp(`^${category}$`, "i"),
          };
        }
        // Priority
        if (priority) {
          query["aiResult.states"] = {
            $elemMatch: {
              title: { $regex: /^priority$/i },
              value: { $regex: new RegExp(`^${priority}$`, "i") },
            },
          };
        }

        const skip = (Number(page) - 1) * Number(limit);
        const total = await tickets.countDocuments(query);

        const result = await tickets
          .find(query)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(Number(limit))
          .toArray();

        return res.send({
          success: true,
          data: result,
          pagination: {
            total,
            page: Number(page),
            limit: Number(limit),
            totalPages: Math.ceil(total / limit),
          },
        });
      } catch (error) {
        return res.status(500).send({
          success: false,
          message: error.message,
        });
      }
    });

    // ============================================= customer dashboard =============================================
    app.get(
      "/dashboard/customer-overview",
      verifyFirebaseToken,
      async (req, res) => {
        try {
          const email = req.user.email;

          // ==========================
          // METRICS
          // ==========================

          const totalTickets = await tickets.countDocuments({
            email,
          });

          const openTickets = await tickets.countDocuments({
            email,
            status: {
              $regex: /^open$/i,
            },
          });

          const pendingTickets = await tickets.countDocuments({
            email,
            status: {
              $regex: /^pending$/i,
            },
          });

          const resolvedTickets = await tickets.countDocuments({
            email,
            status: {
              $regex: /^resolved$/i,
            },
          });

          const aiResolved = await tickets.countDocuments({
            email,
            resolutionSource: {
              $regex: /^ai$/i,
            },
          });

          // ==========================
          // STATUS CHART
          // ==========================

          const statusAggregation = await tickets
            .aggregate([
              {
                $match: {
                  email,
                },
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
            pending: 0,
            resolved: 0,
          };

          statusAggregation.forEach((item) => {
            statusChart[item._id] = item.count;
          });

          // ==========================
          // ACTIVITY CHART (LAST 12 MONTHS)
          // ==========================

          const twelveMonthsAgo = new Date();
          twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 11);

          const activityAggregation = await tickets
            .aggregate([
              {
                $match: {
                  email,
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
            const date = new Date();
            date.setMonth(date.getMonth() - i);

            const monthString = date.toISOString().slice(0, 7);

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

          // ==========================
          // RECENT TICKETS
          // ==========================
          const recentTickets = await tickets
            .find({
              email,
            })
            .sort({
              createdAt: -1,
            })
            .limit(3)
            .project({
              ticketNumber: 1,
              status: 1,
              updatedAt: 1,
              "aiResult.ticketTitle": 1,
              "aiResult.states": 1,
              "aiResult.summary": 1,
              "aiResult.category": 1,
            })
            .toArray();

          // ==========================
          // INSIGHTS
          // ==========================
          const resolutionRate =
            totalTickets > 0
              ? Math.round((resolvedTickets / totalTickets) * 100)
              : 0;
          // ==========================
          // RESPONSE
          // ==========================
          return res.send({
            success: true,
            metrics: {
              totalTickets,
              openTickets,
              pendingTickets,
              resolvedTickets,
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
          return res.status(500).send({
            success: false,
            message: error.message,
          });
        }
      },
    );

    // ============================================= AGENT RELATED ==================================================

    // ================= AGENT DASHBOARD =================
    app.get(
      "/dashboard/agent-overview",
      verifyFirebaseToken,
      verifyAgent,
      async (req, res) => {
        try {
          const agentEmail = req.agent.email;
          const companyId = new ObjectId(req.agent.companyId);

          // ================= Metrics =================
          const assignedToMe = await tickets.countDocuments({
            "assignedAgent.email": agentEmail,
          });

          const openCompanyTickets = await tickets.countDocuments({
            companyId,
            status: "open",
          });

          const inProgressTickets = await tickets.countDocuments({
            "assignedAgent.email": agentEmail,
            status: "in_progress",
          });

          const resolvedToday = await tickets.countDocuments({
            "assignedAgent.email": agentEmail,
            status: "resolved",
            updatedAt: {
              $gte: new Date(new Date().setHours(0, 0, 0, 0)),
            },
          });

          // ================= Status Chart =================
          const statusResult = await tickets
            .aggregate([
              {
                $match: {
                  companyId,
                },
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

          statusResult.forEach((item) => {
            statusChart[item._id] = item.count;
          });

          // ================= Priority Chart =================
          const priorityResult = await tickets
            .aggregate([
              {
                $match: {
                  companyId,
                },
              },
              {
                $unwind: "$aiResult.states",
              },
              {
                $match: {
                  "aiResult.states.title": {
                    $regex: "^priority$",
                    $options: "i",
                  },
                },
              },

              {
                $group: {
                  _id: {
                    $toLower: "$aiResult.states.value",
                  },
                  count: {
                    $sum: 1,
                  },
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
            priorityChart[item._id] = item.count;
          });

          // ================= Recent Tickets =================

          const recentTickets = await tickets
            .find({
              companyId,
            })
            .sort({
              createdAt: -1,
            })
            .limit(3)
            .toArray();

          // ================= Urgent Tickets =================
          const urgentTickets = await tickets
            .find({
              companyId,

              status: {
                $regex: "^open$",
                $options: "i",
              },

              "aiResult.states": {
                $elemMatch: {
                  title: {
                    $regex: "^priority$",
                    $options: "i",
                  },
                  value: {
                    $regex: "^(high|critical)$",
                    $options: "i",
                  },
                },
              },
            })
            .sort({ createdAt: -1 })
            .limit(3)
            .toArray();

          // ====================

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
            urgentTickets,
          });
        } catch (error) {
          res.status(500).send({
            success: false,
            message: error.message,
          });
        }
      },
    );

    // ================= GET COMPANY TICKETS =================
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

          // company filter
          const queryData = {
            companyId: new ObjectId(req.agent.companyId),
          };

          // Search
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
                email: {
                  $regex: search,
                  $options: "i",
                },
              },
            ];
          }
          // Status
          if (status) {
            queryData.status = {
              $regex: new RegExp(`^${status}$`, "i"),
            };
          }
          // Category
          if (category) {
            queryData["aiResult.category"] = {
              $regex: new RegExp(`^${category}$`, "i"),
            };
          }
          // Priority
          if (priority) {
            queryData["aiResult.states"] = {
              $elemMatch: {
                title: { $regex: /^priority$/i },
                value: { $regex: new RegExp(`^${priority}$`, "i") },
              },
            };
          }

          // ======= pagination ========
          const skip = (Number(page) - 1) * Number(limit);
          const total = await tickets.countDocuments(queryData);

          const result = await tickets
            .find(queryData)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(Number(limit))
            .toArray();

          console.log(queryData);
          console.log(result);
          return res.send({
            success: true,
            data: result,
            currentAgent: req.agent.email,
            pagination: {
              total,
              page: Number(page),
              limit: Number(limit),
              totalPages: Math.ceil(total / limit),
            },
          });
        } catch (error) {
          return res.status(500).send({
            success: false,
            message: error.message,
          });
        }
      },
    );

    // ================= GET AGENT ASSIGNED TICKETS =================
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

          const queryData = {
            companyId: new ObjectId(req.agent.companyId),
            "assignedAgent.email": req.agent.email,
          };

          // Search
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
                email: {
                  $regex: search,
                  $options: "i",
                },
              },
            ];
          }

          // Status
          if (status) {
            queryData.status = {
              $regex: new RegExp(`^${status}$`, "i"),
            };
          }

          // Category
          if (category) {
            queryData["aiResult.category"] = {
              $regex: new RegExp(`^${category}$`, "i"),
            };
          }

          // Priority
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

          // Pagination
          const pageNumber = Number(page);
          const limitNumber = Number(limit);
          const skip = (pageNumber - 1) * limitNumber;

          const total = await tickets.countDocuments(queryData);

          const result = await tickets
            .find(queryData)
            .sort({
              updatedAt: -1,
              createdAt: -1,
            })
            .skip(skip)
            .limit(limitNumber)
            .toArray();

          return res.send({
            success: true,
            data: result,
            currentAgent: req.agent.email,
            pagination: {
              total,
              page: pageNumber,
              limit: limitNumber,
              totalPages: Math.ceil(total / limitNumber),
            },
          });
        } catch (error) {
          console.error("Assigned tickets error:", error);

          return res.status(500).send({
            success: false,
            message: error.message,
          });
        }
      },
    );

    // =============== HANDLE TO ASSIGN TICKET =================
// ================= ASSIGN TICKET TO AGENT =================
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

      if (
        !req.agent.companyId ||
        !ObjectId.isValid(req.agent.companyId)
      ) {
        return res.status(400).send({
          success: false,
          message: "Agent company information is invalid",
        });
      }

      const ticketId = new ObjectId(id);
      const companyId = new ObjectId(req.agent.companyId);
      const assignedAt = new Date();

      const assignedAgent = {
        uid: req.agent.uid,
        email: req.agent.email,
        displayName: req.agent.displayName,
      };

      const result = await tickets.updateOne(
        {
          _id: ticketId,
          companyId,
          status: "open",
          assignedAgent: { $exists: false },
        },
        {
          $set: {
            assignedAgent,
            status: "assigned",
            assignedAt,
            updatedAt: assignedAt,
          },
          $push: {
            assignmentHistory: {
              action: "assigned",
              agent: assignedAgent,
              createdAt: assignedAt,
            },
          },
        },
      );

      if (result.matchedCount === 0) {
        return res.status(409).send({
          success: false,
          message:
            "Ticket is already assigned, unavailable, or does not belong to your company",
        });
      }

      const ticket = await tickets.findOne({
        _id: ticketId,
        companyId,
      });

      try {
        await createNotification({
          uid: ticket.uid,
          userEmail: ticket.email,
          title: "Ticket Assigned",
          message: `Your ticket ${ticket.ticketNumber} has been assigned to ${req.agent.displayName}.`,
          type: "ticket_assigned",
          ticketId: ticket._id,
          ticketNumber: ticket.ticketNumber,
          path: "/customer/my-tickets",
        });

        await createNotification({
          uid: req.agent.uid,
          userEmail: req.agent.email,
          title: "Ticket Claimed",
          message: `You claimed ticket ${ticket.ticketNumber}.`,
          type: "ticket_claimed",
          ticketId: ticket._id,
          ticketNumber: ticket.ticketNumber,
          path: `/agent/tickets/${ticket._id}`,
        });
      } catch (notificationError) {
        console.error(
          "Ticket assignment notification error:",
          notificationError.message,
        );
      }

      return res.send({
        success: true,
        message: "Ticket assigned successfully",
        data: ticket,
      });
    } catch (error) {
      console.error("Assign ticket error:", error);

      return res.status(500).send({
        success: false,
        message: error.message,
      });
    }
  },
);

    // ================= RETURN TICKET TO COMPANY QUEUE =================
    app.patch(
      "/agent/tickets/:id/release",
      verifyFirebaseToken,
      verifyAgent,
      async (req, res) => {
        try {
          const ticketId = req.params.id;

          if (!ObjectId.isValid(ticketId)) {
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

          const companyId = new ObjectId(req.agent.companyId);
          const ticketObjectId = new ObjectId(ticketId);
          const releasedAt = new Date();

          const result = await tickets.updateOne(
            {
              _id: ticketObjectId,
              companyId,
              "assignedAgent.email": req.agent.email,
              status: {
                $in: ["assigned", "in_progress"],
              },
            },
            {
              $unset: {
                assignedAgent: "",
              },
              $set: {
                status: "open",
                updatedAt: releasedAt,
              },
              $push: {
                assignmentHistory: {
                  action: "released",
                  agent: {
                    uid: req.agent.uid,
                    email: req.agent.email,
                    displayName: req.agent.displayName,
                  },
                  createdAt: releasedAt,
                },
              },
            },
          );

          if (result.matchedCount === 0) {
            return res.status(404).send({
              success: false,
              message:
                "Ticket not found, already released, or not assigned to you",
            });
          }

          const ticket = await tickets.findOne({
            _id: ticketObjectId,
            companyId,
          });

          // Notification
          try {
            await createNotification({
              uid: ticket.uid,
              userEmail: ticket.email,
              title: "Ticket Returned to Support Queue",
              message: `Your ticket ${ticket.ticketNumber} has been returned to the support queue and will be assigned to another available agent.`,
              type: "ticket_released",
              ticketId: ticket._id,
              ticketNumber: ticket.ticketNumber,
              path: "/customer/tickets",
            });

            await createNotification({
              uid: req.agent.uid,
              userEmail: req.agent.email,
              title: "Ticket Returned to Queue",
              message: `You returned ticket ${ticket.ticketNumber} to the company queue.`,
              type: "ticket_returned",
              ticketId: ticket._id,
              ticketNumber: ticket.ticketNumber,
              path: "/agent/company-tickets",
            });
          } catch (notificationError) {
            console.error(
              "Ticket release notification error:",
              notificationError.message,
            );
          }

          return res.send({
            success: true,
            message: "Ticket returned to company queue successfully",
            data: ticket,
          });
        } catch (error) {
          console.error("Release ticket error:", error);

          return res.status(500).send({
            success: false,
            message: error.message,
          });
        }
      },
    );

    //  ============ notification ==============
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

    // ================================================ AI ANALYZE TICKET ==========================================
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
