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
//============== get agent function ====================
const getCurrentAgentUid = (agentHistory = []) => {
  if (!agentHistory.length) return null;

  const latest = agentHistory.reduce((latest, current) => {
    if (!latest) return current;

    return new Date(current.date) > new Date(latest.date) ? current : latest;
  }, null);

  return latest?.action === "assigned" ? latest.uid : null;
};
// =================
// ================= GET LAST AGENT HISTORY =================
const getLastAgentHistory = (agentHistory = [], action = null) => {
  if (!agentHistory.length) return null;

  const sortedHistory = [...agentHistory].sort(
    (a, b) => new Date(b.date) - new Date(a.date),
  );

  if (!action) {
    return sortedHistory[0] || null;
  }

  return sortedHistory.find((item) => item.action === action) || null;
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

        if (!bodyData?.ticketData || !bodyData?.aiResult) {
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
          uid: user.uid,
          ticketNumber: ticketNumber,
          companyId: new ObjectId(user.companyId),
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        const result = await tickets.insertOne(ticket);

        // ======== create notification ============
        try {
          await createNotification({
            uid: user.uid,
            userEmail: user.email,
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

        const pageNumber = Number(page);
        const limitNumber = Number(limit);
        const skip = (pageNumber - 1) * limitNumber;

        const total = await tickets.countDocuments(queryData);

        const result = await tickets
          .aggregate([
            {
              $match: queryData,
            },
            {
              $sort: {
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
              $lookup: {
                from: "users",
                localField: "agentHistory.uid",
                foreignField: "uid",
                as: "agentUsers",
              },
            },
            {
              $lookup: {
                from: "users",
                localField: "uid",
                foreignField: "uid",
                as: "userInfo",
              },
            },
            {
              $project: {
                _id: 1,
                companyId: 1,
                ticketNumber: 1,
                status: 1,
                supportMode: 1,
                aiResolved: 1,
                createdAt: 1,
                updatedAt: 1,
                agentHistory: 1,

                "aiResult.category": 1,
                "aiResult.states": 1,
                "aiResult.summary": 1,
                "aiResult.ticketTitle": 1,

                agentUsers: {
                  uid: 1,
                  displayName: 1,
                  name: 1,
                  email: 1,
                  photoURL: 1,
                  role: 1,
                },

                userInfo: {
                  uid: 1,
                  displayName: 1,
                  name: 1,
                  email: 1,
                  photoURL: 1,
                  role: 1,
                },
              },
            },
          ])
          .toArray();

        const finalResult = result.map((ticket) => {
          const currentAgentUid = getCurrentAgentUid(ticket.agentHistory || []);

          const currentAgent = currentAgentUid
            ? ticket.agentUsers?.find((agent) => agent.uid === currentAgentUid)
            : null;

          const currentCustomer = ticket.userInfo?.[0] || null;

          const { agentUsers, userInfo, ...ticketWithoutLookup } = ticket;

          return {
            ...ticketWithoutLookup,
            agentInfo: currentAgent || null,
            userInfo: currentCustomer,
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

    // ============================================= customer dashboard =============================================
    // ==============================================================================================================
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
            .limit(5)
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

    // ================= GET SINGLE TICKET =================
    app.get("/tickets/:ticketId", verifyFirebaseToken, async (req, res) => {
      try {
        const { ticketId } = req.params;

        // ================= VALIDATE TICKET ID =================

        if (!ObjectId.isValid(ticketId)) {
          return res.status(400).send({
            success: false,
            message: "Invalid ticket ID",
          });
        }

        // ================= GET CURRENT USER =================

        const currentUser = await users.findOne({
          uid: req.user.uid,
        });

        if (!currentUser) {
          return res.status(404).send({
            success: false,
            message: "User not found",
          });
        }

        // ================= GET TICKET =================

        const ticket = await tickets.findOne({
          _id: new ObjectId(ticketId),
        });

        if (!ticket) {
          return res.status(404).send({
            success: false,
            message: "Ticket not found",
          });
        }

        // ================= CUSTOMER INFO =================

        const customer = await users.findOne({
          uid: ticket.uid,
        });

        let customerInfo = null;

        if (customer) {
          const company = customer.companyId
            ? await companies.findOne({
                _id: new ObjectId(customer.companyId),
              })
            : null;

          customerInfo = {
            uid: customer.uid,
            displayName: customer.displayName || customer.name || "Customer",
            email: customer.email || "",
            photoURL: customer.photoURL || "",
            role: customer.role || "customer",
            status: customer.status || "active",
            companyName: company?.companyName || "",
          };
        }

        // ================= CUSTOMER =================

        if (currentUser.role === "customer") {
          if (ticket.uid !== currentUser.uid) {
            return res.status(403).send({
              success: false,
              message: "You are not allowed to view this ticket",
            });
          }

          return res.send({
            success: true,
            data: ticket,
            customerInfo,
          });
        }

        // ================= OWNER / ADMIN =================

        if (currentUser.role === "owner" || currentUser.role === "admin") {
          return res.send({
            success: true,
            data: ticket,
            customerInfo,
          });
        }

        // ================= AGENT =================

        if (currentUser.role === "agent") {
          // ================= GET LAST AGENT HISTORY =================

          const lastAgentHistory = getLastAgentHistory(
            ticket.agentHistory || [],
          );

          // ================= CURRENT AGENT =================

          const isCurrentAgent =
            lastAgentHistory?.uid === currentUser.uid &&
            ["assigned", "in_progress", "resolved"].includes(
              lastAgentHistory.action,
            );

          // ================= TICKET IS CURRENTLY ASSIGNED =================

          const isCurrentlyAssigned =
            lastAgentHistory &&
            ["assigned", "in_progress", "resolved"].includes(
              lastAgentHistory.action,
            );

          // ================= ANOTHER AGENT OWNS TICKET =================

          if (isCurrentlyAssigned && !isCurrentAgent) {
            return res.status(403).send({
              success: false,
              message: "This ticket is currently assigned to another agent",
            });
          }

          // ================= AGENT CAN VIEW =================

          return res.send({
            success: true,
            data: ticket,
            customerInfo,

            permission: {
              canSendMessage: isCurrentAgent,
              canSuggestReply: isCurrentAgent,
              canRelease: isCurrentAgent,
              isCurrentAgent,
            },
          });
        }

        // ================= UNAUTHORIZED =================

        return res.status(403).send({
          success: false,
          message: "You are not allowed to view this ticket",
        });
      } catch (error) {
        console.error("Get ticket details error:", error);

        return res.status(500).send({
          success: false,
          message: "Failed to fetch ticket details",
          error: error.message,
        });
      }
    });

    // ================= DELETE SINGLE TICKET =================
    app.delete("/tickets/:ticketId", verifyFirebaseToken, async (req, res) => {
      try {
        const { ticketId } = req.params;

        if (!ObjectId.isValid(ticketId)) {
          return res.status(400).send({
            success: false,
            message: "Invalid ticket id",
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

        let canDelete = false;

        // Customer own ticket
        if (currentUser.role === "customer" && ticket.uid === currentUser.uid) {
          canDelete = true;
        }

        // Owner/Admin all ticket
        if (currentUser.role === "owner" || currentUser.role === "admin") {
          canDelete = true;
        }

        if (!canDelete) {
          return res.status(403).send({
            success: false,
            message: "You don't have permission to delete this ticket",
          });
        }

        const result = await tickets.deleteOne({
          _id: new ObjectId(ticketId),
        });

        if (result.deletedCount === 0) {
          return res.status(400).send({
            success: false,
            message: "Ticket delete failed",
          });
        }

        // notification
        try {
          await createNotification({
            uid: ticket.uid,
            userEmail: ticket.email,
            title: "Ticket Deleted",
            message: `Your ticket ${ticket.ticketNumber} has been deleted.`,
            type: "ticket_deleted",
            ticketNumber: ticket.ticketNumber,
            path: "/customer/my-tickets",
          });
        } catch (err) {
          console.log("Delete notification error:", err.message);
        }

        return res.send({
          success: true,
          message: "Ticket deleted successfully",
        });
      } catch (error) {
        console.error("Delete ticket error:", error);

        return res.status(500).send({
          success: false,
          message: error.message,
        });
      }
    });

    // ============================================= AGENT RELATED ==================================================
    // ==============================================================================================================

    // ================= AGENT DASHBOARD =====================================
    app.get(
      "/dashboard/agent-overview",
      verifyFirebaseToken,
      verifyAgent,
      async (req, res) => {
        try {
          // ================= AGENT INFORMATION =================
          const agentUid = req.agent.uid;

          if (!req.agent.companyId || !ObjectId.isValid(req.agent.companyId)) {
            return res.status(400).send({
              success: false,
              message: "Agent company information is invalid",
            });
          }

          const companyId = new ObjectId(req.agent.companyId);

          // =====================================================
          // ================= HELPER =============================
          // =====================================================

          // Check whether this agent is the CURRENT agent
          // according to the latest agentHistory action
          const currentAgentMatch = {
            $expr: {
              $eq: [
                {
                  $let: {
                    vars: {
                      latestHistory: {
                        $arrayElemAt: [
                          {
                            $sortArray: {
                              input: "$agentHistory",
                              sortBy: {
                                date: -1,
                              },
                            },
                          },
                          0,
                        ],
                      },
                    },
                    in: {
                      $cond: [
                        {
                          $eq: ["$$latestHistory.action", "assigned"],
                        },
                        "$$latestHistory.uid",
                        null,
                      ],
                    },
                  },
                },
                agentUid,
              ],
            },
          };

          // =====================================================
          // ================= METRICS ===========================
          // =====================================================

          // Total tickets currently assigned to this agent
          const assignedToMe = await tickets.countDocuments({
            companyId,
            $expr: {
              $eq: [
                {
                  $let: {
                    vars: {
                      latestHistory: {
                        $arrayElemAt: [
                          {
                            $sortArray: {
                              input: "$agentHistory",
                              sortBy: {
                                date: -1,
                              },
                            },
                          },
                          0,
                        ],
                      },
                    },
                    in: {
                      $cond: [
                        {
                          $eq: ["$$latestHistory.action", "assigned"],
                        },
                        "$$latestHistory.uid",
                        null,
                      ],
                    },
                  },
                },
                agentUid,
              ],
            },
          });

          // =====================================================
          // ALL OPEN TICKETS OF THIS COMPANY
          // =====================================================

          const openCompanyTickets = await tickets.countDocuments({
            companyId,
            status: {
              $regex: /^open$/i,
            },
          });

          // =====================================================
          // IN-PROGRESS TICKETS ASSIGNED TO THIS AGENT
          // =====================================================

          const inProgressTickets = await tickets.countDocuments({
            companyId,
            status: {
              $regex: /^in_progress$/i,
            },
            $expr: {
              $eq: [
                {
                  $let: {
                    vars: {
                      latestHistory: {
                        $arrayElemAt: [
                          {
                            $sortArray: {
                              input: "$agentHistory",
                              sortBy: {
                                date: -1,
                              },
                            },
                          },
                          0,
                        ],
                      },
                    },
                    in: {
                      $cond: [
                        {
                          $eq: ["$$latestHistory.action", "assigned"],
                        },
                        "$$latestHistory.uid",
                        null,
                      ],
                    },
                  },
                },
                agentUid,
              ],
            },
          });

          // =====================================================
          // RESOLVED BY THIS AGENT TODAY
          // =====================================================

          const todayStart = new Date();
          todayStart.setHours(0, 0, 0, 0);

          const resolvedToday = await tickets.countDocuments({
            companyId,
            status: {
              $regex: /^resolved$/i,
            },
            updatedAt: {
              $gte: todayStart,
            },
            $expr: {
              $eq: [
                {
                  $let: {
                    vars: {
                      latestHistory: {
                        $arrayElemAt: [
                          {
                            $sortArray: {
                              input: "$agentHistory",
                              sortBy: {
                                date: -1,
                              },
                            },
                          },
                          0,
                        ],
                      },
                    },
                    in: {
                      $cond: [
                        {
                          $eq: ["$$latestHistory.action", "assigned"],
                        },
                        "$$latestHistory.uid",
                        null,
                      ],
                    },
                  },
                },
                agentUid,
              ],
            },
          });

          // =====================================================
          // ================= STATUS CHART ======================
          // =====================================================

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
            if (item._id in statusChart) {
              statusChart[item._id] = item.count;
            }
          });

          // =====================================================
          // ================= PRIORITY CHART ====================
          // =====================================================

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
                    $regex: /^priority$/i,
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
            if (item._id in priorityChart) {
              priorityChart[item._id] = item.count;
            }
          });

          // =====================================================
          // ================= RECENT TICKETS ===================
          // =====================================================

          const recentTickets = await tickets
            .aggregate([
              {
                $match: {
                  companyId,
                },
              },

              // Current agent only
              {
                $match: currentAgentMatch,
              },

              {
                $sort: {
                  createdAt: -1,
                },
              },

              {
                $limit: 5,
              },
            ])
            .toArray();

          // =====================================================
          // ================= URGENT TICKETS ====================
          // =====================================================

          const urgentTickets = await tickets
            .aggregate([
              {
                $match: {
                  companyId,

                  status: {
                    $regex: /^open$/i,
                  },

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

              // Current agent only
              {
                $match: currentAgentMatch,
              },

              {
                $sort: {
                  createdAt: -1,
                },
              },

              {
                $limit: 3,
              },
            ])
            .toArray();

          // =====================================================
          // ================= RESPONSE ==========================
          // =====================================================

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
          console.error("Agent dashboard error:", error);

          return res.status(500).send({
            success: false,
            message: error.message,
          });
        }
      },
    );

    // ================= GET COMPANY TICKETS =================================
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

          // ================= COMPANY FILTER =================

          const queryData = {
            companyId: new ObjectId(req.agent.companyId),
          };

          // ================= SEARCH =================

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

          // ================= STATUS =================

          if (status) {
            queryData.status = {
              $regex: new RegExp(`^${status}$`, "i"),
            };
          }

          // ================= CATEGORY =================

          if (category) {
            queryData["aiResult.category"] = {
              $regex: new RegExp(`^${category}$`, "i"),
            };
          }

          // ================= PRIORITY =================

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

          // ================= PAGINATION =================

          const pageNumber = Number(page);
          const limitNumber = Number(limit);

          const skip = (pageNumber - 1) * limitNumber;

          // ================= TOTAL =================

          const total = await tickets.countDocuments(queryData);

          // ================= GET TICKETS =================

          const result = await tickets
            .aggregate([
              {
                $match: queryData,
              },

              {
                $sort: {
                  createdAt: -1,
                },
              },

              {
                $skip: skip,
              },

              {
                $limit: limitNumber,
              },

              // ================= GET AGENT INFORMATION =================

              {
                $lookup: {
                  from: "users",
                  localField: "agentHistory.uid",
                  foreignField: "uid",
                  as: "agentUsers",
                },
              },

              // ================= GET CUSTOMER INFORMATION =================

              {
                $lookup: {
                  from: "users",
                  localField: "uid",
                  foreignField: "uid",
                  as: "userInfo",
                },
              },

              // ================= PROJECT =================

              {
                $project: {
                  _id: 1,
                  companyId: 1,
                  ticketNumber: 1,
                  status: 1,
                  aiResolved: 1,
                  createdAt: 1,
                  updatedAt: 1,
                  agentHistory: 1,

                  // ================= AI RESULT =================
                  "aiResult.category": 1,
                  "aiResult.states": 1,
                  "aiResult.summary": 1,
                  "aiResult.ticketTitle": 1,

                  // ================= AGENT USERS =================
                  agentUsers: {
                    uid: 1,
                    displayName: 1,
                    name: 1,
                    email: 1,
                    photoURL: 1,
                    role: 1,
                  },

                  // ================= CUSTOMER USER =================
                  userInfo: {
                    uid: 1,
                    displayName: 1,
                    name: 1,
                    email: 1,
                    photoURL: 1,
                    role: 1,
                  },
                },
              },
            ])
            .toArray();

          // ================= FINAL RESULT =================
          const finalResult = result.map((ticket) => {
            const lastAgentHistory = getLastAgentHistory(
              ticket.agentHistory || [],
            );

            const currentUser = ticket.userInfo?.[0] || null;

            const { agentUsers, userInfo, ...ticketWithoutLookup } = ticket;

            // Only active agent actions should show agent information
            const activeAgentActions = ["assigned", "in_progress", "resolved"];

            const shouldShowAgent =
              lastAgentHistory &&
              activeAgentActions.includes(lastAgentHistory.action);

            const lastAgent = shouldShowAgent
              ? ticket.agentUsers?.find(
                  (agent) => agent.uid === lastAgentHistory.uid,
                )
              : null;

            return {
              ...ticketWithoutLookup,

              // Agent information
              agentInfo: lastAgent || null,

              // Latest action
              agentAction: lastAgentHistory?.action || null,

              // Customer information
              userInfo: currentUser,
            };
          });

          // ================= RESPONSE =================
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
            message: error.message,
          });
        }
      },
    );

    // ================= GET ASSIGNED TICKETS TO AGENT =======================
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

          // ================= VALIDATE COMPANY =================
          if (!req.agent.companyId || !ObjectId.isValid(req.agent.companyId)) {
            return res.status(400).send({
              success: false,
              message: "Agent company information is invalid",
            });
          }

          const companyId = new ObjectId(req.agent.companyId);

          const pageNumber = Number(page);
          const limitNumber = Number(limit);
          const skip = (pageNumber - 1) * limitNumber;

          // ================= BASE QUERY =================
          // Only show ticket when the LATEST agentHistory
          // belongs to current agent AND action is "assigned"
          const queryData = {
            companyId,

            $expr: {
              $let: {
                vars: {
                  latestHistory: {
                    $arrayElemAt: ["$agentHistory", -1],
                  },
                },

                in: {
                  $and: [
                    {
                      $eq: ["$$latestHistory.uid", req.agent.uid],
                    },
                    {
                      $in: [
                        "$$latestHistory.action",
                        ["assigned", "in_progress", "resolved"],
                      ],
                    },
                  ],
                },
              },
            },
          };

          // ================= SEARCH =================
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

          // ================= STATUS =================
          if (status) {
            queryData.status = {
              $regex: new RegExp(`^${status}$`, "i"),
            };
          }

          // ================= CATEGORY =================
          if (category) {
            queryData["aiResult.category"] = {
              $regex: new RegExp(`^${category}$`, "i"),
            };
          }

          // ================= PRIORITY =================
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

          // ================= TOTAL =================
          const total = await tickets.countDocuments(queryData);

          // ================= GET TICKETS =================
          const result = await tickets
            .aggregate([
              // -------- Filter --------
              {
                $match: queryData,
              },

              // -------- Latest updated tickets first --------
              {
                $sort: {
                  updatedAt: -1,
                  createdAt: -1,
                },
              },

              // -------- Pagination --------
              {
                $skip: skip,
              },
              {
                $limit: limitNumber,
              },

              // =================================================
              // GET CUSTOMER INFO FROM USERS
              // ticket.uid === users.uid
              // =================================================
              {
                $lookup: {
                  from: "users",
                  localField: "uid",
                  foreignField: "uid",
                  as: "userInfo",
                },
              },

              // =================================================
              // PROJECT ONLY REQUIRED DATA
              // =================================================
              {
                $project: {
                  _id: 1,

                  // ================= BASIC =================
                  uid: 1,
                  companyId: 1,
                  ticketNumber: 1,
                  status: 1,
                  aiResolved: 1,
                  createdAt: 1,
                  updatedAt: 1,

                  // ================= AI RESULT =================
                  "aiResult.category": 1,
                  "aiResult.states": 1,
                  "aiResult.summary": 1,
                  "aiResult.ticketTitle": 1,

                  // ================= USER INFO =================
                  userInfo: {
                    uid: 1,
                    displayName: 1,
                    name: 1,
                    email: 1,
                    photoURL: 1,
                    role: 1,
                  },
                },
              },
            ])
            .toArray();

          // =================================================
          // FORMAT FINAL RESULT
          // =================================================
          const finalResult = result.map((ticket) => {
            return {
              ...ticket,

              // $lookup returns array
              // Convert to single user object
              userInfo: ticket.userInfo?.[0] || null,

              // Current logged-in agent
              agentInfo: {
                uid: req.agent.uid,
                email: req.agent.email,
                displayName: req.agent.displayName || req.agent.name || "Agent",
              },
            };
          });

          // ================= RESPONSE =================
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
          console.error("Assigned tickets error:", error);

          return res.status(500).send({
            success: false,
            message: "Failed to fetch assigned tickets",
          });
        }
      },
    );

    // ================= UPDATE ASSIGN TICKET TO AGENT =======================
    app.patch(
      "/agent/tickets/:id/assign",
      verifyFirebaseToken,
      verifyAgent,
      async (req, res) => {
        try {
          const { id } = req.params;

          // ================= VALIDATE TICKET ID =================
          if (!ObjectId.isValid(id)) {
            return res.status(400).send({
              success: false,
              message: "Invalid ticket id",
            });
          }

          // ================= VALIDATE COMPANY =================
          if (!req.agent.companyId || !ObjectId.isValid(req.agent.companyId)) {
            return res.status(400).send({
              success: false,
              message: "Agent company information is invalid",
            });
          }

          const ticketId = new ObjectId(id);
          const companyId = new ObjectId(req.agent.companyId);
          const assignedAt = new Date();

          // ================= FIND TICKET =================
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

          // ================= GET LAST AGENT HISTORY =================
          const lastAgentHistory = getLastAgentHistory(
            ticket.agentHistory || [],
          );

          // ================= CHECK CURRENT ASSIGNMENT =================
          if (
            lastAgentHistory &&
            ["assigned", "in_progress", "resolved"].includes(
              lastAgentHistory.action,
            )
          ) {
            return res.status(409).send({
              success: false,
              message: "This ticket is already assigned to an agent",
            });
          }

          // ================= CHECK STATUS =================
          if (ticket.status !== "open") {
            return res.status(409).send({
              success: false,
              message: "Only open tickets can be assigned to an agent",
            });
          }

          // ================= ASSIGN TICKET =================
          const result = await tickets.updateOne(
            {
              _id: ticketId,
              companyId,
              status: "open",
            },
            {
              $set: {
                status: "assigned",
                updatedAt: assignedAt,
              },

              $push: {
                agentHistory: {
                  uid: req.agent.uid,
                  action: "assigned",
                  date: assignedAt,
                },
              },
            },
          );

          // ================= UPDATE FAILED =================
          if (result.modifiedCount === 0) {
            return res.status(409).send({
              success: false,
              message:
                "Ticket could not be assigned. It may have already been assigned or updated.",
            });
          }

          // ================= GET UPDATED TICKET =================
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

          // ================= NOTIFICATIONS =================
          try {
            // Customer notification
            await createNotification({
              uid: updatedTicket.uid,
              userEmail: updatedTicket.email,
              title: "Ticket Assigned to Support Agent",
              message: `Your ticket ${updatedTicket.ticketNumber} has been assigned to a support agent. They will review your issue and assist you shortly.`,
              type: "ticket_assigned",
              ticketId: updatedTicket._id,
              ticketNumber: updatedTicket.ticketNumber,
              path: "/customer/my-tickets",
            });

            // Agent notification
            await createNotification({
              uid: req.agent.uid,
              userEmail: req.agent.email,
              title: "Ticket Assigned to You",
              message: `Ticket ${updatedTicket.ticketNumber} has been assigned to you.`,
              type: "ticket_assigned",
              ticketId: updatedTicket._id,
              ticketNumber: updatedTicket.ticketNumber,
              path: `/agent/tickets/${updatedTicket._id}`,
            });
          } catch (notificationError) {
            console.error(
              "Ticket assignment notification error:",
              notificationError.message,
            );
          }

          // ================= RESPONSE =================
          return res.send({
            success: true,
            message: "Ticket assigned successfully",
            data: updatedTicket,
          });
        } catch (error) {
          console.error("Assign ticket error:", error);

          return res.status(500).send({
            success: false,
            message: "Failed to assign ticket",
          });
        }
      },
    );

    // ================= UPDATE RELEASE TICKET TO COMPANY ====================
    app.patch(
      "/agent/tickets/:id/release",
      verifyFirebaseToken,
      verifyAgent,
      async (req, res) => {
        try {
          const { id } = req.params;

          // ================= VALIDATE TICKET ID =================
          if (!ObjectId.isValid(id)) {
            return res.status(400).send({
              success: false,
              message: "Invalid ticket id",
            });
          }

          // ================= VALIDATE COMPANY =================
          if (!req.agent.companyId || !ObjectId.isValid(req.agent.companyId)) {
            return res.status(400).send({
              success: false,
              message: "Agent company information is invalid",
            });
          }

          const ticketId = new ObjectId(id);
          const companyId = new ObjectId(req.agent.companyId);
          const releasedAt = new Date();

          // ================= FIND TICKET =================
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

          // ================= GET LAST AGENT HISTORY =================
          const lastAgentHistory = getLastAgentHistory(
            ticket.agentHistory || [],
          );

          // ================= CHECK CURRENT ASSIGNMENT =================
          if (!lastAgentHistory) {
            return res.status(409).send({
              success: false,
              message: "This ticket is not currently assigned to any agent",
            });
          }

          // ================= CHECK CURRENT AGENT =================
          if (lastAgentHistory.uid !== req.agent.uid) {
            return res.status(403).send({
              success: false,
              message: "You are not the current agent of this ticket",
            });
          }

          // ================= CHECK CURRENT ACTION =================
          if (!["assigned", "in_progress"].includes(lastAgentHistory.action)) {
            return res.status(409).send({
              success: false,
              message: "This ticket is not currently assigned to you",
            });
          }

          // ================= CHECK STATUS =================
          if (!["assigned", "in_progress"].includes(ticket.status)) {
            return res.status(409).send({
              success: false,
              message: "This ticket cannot be released in its current status",
            });
          }

          // ================= RELEASE TICKET =================
          const result = await tickets.updateOne(
            {
              _id: ticketId,
              companyId,
              status: {
                $in: ["assigned", "in_progress"],
              },
            },
            {
              $set: {
                status: "open",
                updatedAt: releasedAt,
              },

              $push: {
                agentHistory: {
                  uid: req.agent.uid,
                  action: "released",
                  date: releasedAt,
                },
              },
            },
          );

          // ================= UPDATE FAILED =================
          if (result.modifiedCount === 0) {
            return res.status(409).send({
              success: false,
              message:
                "Ticket could not be released. It may have already been updated.",
            });
          }

          // ================= GET UPDATED TICKET =================
          const updatedTicket = await tickets.findOne({
            _id: ticketId,
            companyId,
          });

          if (!updatedTicket) {
            return res.status(404).send({
              success: false,
              message: "Ticket not found after release",
            });
          }

          // ================= NOTIFICATIONS =================
          try {
            // Customer notification
            await createNotification({
              uid: updatedTicket.uid,
              userEmail: updatedTicket.email,
              title: "Ticket Returned to Support Queue",
              message: `Your ticket ${updatedTicket.ticketNumber} has been returned to the support queue and will be assigned to another available agent.`,
              type: "ticket_released",
              ticketId: updatedTicket._id,
              ticketNumber: updatedTicket.ticketNumber,
              path: "/customer/my-tickets",
            });

            // Agent notification
            await createNotification({
              uid: req.agent.uid,
              userEmail: req.agent.email,
              title: "Ticket Returned to Queue",
              message: `You returned ticket ${updatedTicket.ticketNumber} to the company queue.`,
              type: "ticket_returned",
              ticketId: updatedTicket._id,
              ticketNumber: updatedTicket.ticketNumber,
              path: `/agent/tickets/${updatedTicket._id}`,
            });
          } catch (notificationError) {
            console.error(
              "Ticket release notification error:",
              notificationError.message,
            );
          }

          // ================= RESPONSE =================
          return res.send({
            success: true,
            message: "Ticket returned to company queue successfully",
            data: updatedTicket,
          });
        } catch (error) {
          console.error("Release ticket error:", error);

          return res.status(500).send({
            success: false,
            message: "Failed to release ticket",
          });
        }
      },
    );

    // ================= UPDATE RESOLVE TICKET ===============================
    app.patch(
      "/agent/tickets/:id/resolve",
      verifyFirebaseToken,
      verifyAgent,
      async (req, res) => {
        try {
          const { id } = req.params;

          // ================= VALIDATE TICKET ID =================
          if (!ObjectId.isValid(id)) {
            return res.status(400).send({
              success: false,
              message: "Invalid ticket id",
            });
          }

          // ================= VALIDATE COMPANY =================
          if (!req.agent.companyId || !ObjectId.isValid(req.agent.companyId)) {
            return res.status(400).send({
              success: false,
              message: "Agent company information is invalid",
            });
          }

          const ticketId = new ObjectId(id);
          const companyId = new ObjectId(req.agent.companyId);
          const resolvedAt = new Date();

          // ================= FIND TICKET =================
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

          // ================= GET LAST AGENT HISTORY =================
          const lastAgentHistory = getLastAgentHistory(
            ticket.agentHistory || [],
          );

          // ================= CHECK CURRENT ASSIGNMENT =================
          if (!lastAgentHistory) {
            return res.status(409).send({
              success: false,
              message: "This ticket is not currently assigned to any agent",
            });
          }

          // ================= CHECK CURRENT AGENT =================
          if (lastAgentHistory.uid !== req.agent.uid) {
            return res.status(403).send({
              success: false,
              message: "You are not the current agent of this ticket",
            });
          }

          // ================= CHECK CURRENT ACTION =================
          if (!["assigned", "in_progress"].includes(lastAgentHistory.action)) {
            return res.status(409).send({
              success: false,
              message: "This ticket is not currently assigned to you",
            });
          }

          // ================= CHECK STATUS =================
          if (!["assigned", "in_progress"].includes(ticket.status)) {
            return res.status(409).send({
              success: false,
              message: "This ticket cannot be resolved in its current status",
            });
          }

          // ================= RESOLVE TICKET =================
          const result = await tickets.updateOne(
            {
              _id: ticketId,
              companyId,
              status: {
                $in: ["assigned", "in_progress"],
              },
            },
            {
              $set: {
                status: "resolved",
                resolutionSource: "agent",
                resolvedAt,
                updatedAt: resolvedAt,
              },

              $push: {
                agentHistory: {
                  uid: req.agent.uid,
                  action: "resolved",
                  date: resolvedAt,
                },
              },
            },
          );

          // ================= UPDATE FAILED =================
          if (result.modifiedCount === 0) {
            return res.status(409).send({
              success: false,
              message:
                "Ticket could not be resolved. It may have already been updated.",
            });
          }

          // ================= GET UPDATED TICKET =================
          const updatedTicket = await tickets.findOne({
            _id: ticketId,
            companyId,
          });

          if (!updatedTicket) {
            return res.status(404).send({
              success: false,
              message: "Ticket not found after resolving",
            });
          }

          // ================= NOTIFICATIONS =================
          try {
            // Customer notification
            await createNotification({
              uid: updatedTicket.uid,
              userEmail: updatedTicket.email,
              title: "Ticket Resolved",
              message: `Your ticket ${updatedTicket.ticketNumber} has been resolved by our support team.`,
              type: "ticket_resolved",
              ticketId: updatedTicket._id,
              ticketNumber: updatedTicket.ticketNumber,
              path: "/customer/my-tickets",
            });

            // Agent notification
            await createNotification({
              uid: req.agent.uid,
              userEmail: req.agent.email,
              title: "Ticket Resolved",
              message: `You resolved ticket ${updatedTicket.ticketNumber}.`,
              type: "ticket_resolved",
              ticketId: updatedTicket._id,
              ticketNumber: updatedTicket.ticketNumber,
              path: `/agent/tickets/${updatedTicket._id}`,
            });
          } catch (notificationError) {
            console.error(
              "Ticket resolve notification error:",
              notificationError.message,
            );
          }

          // ================= RESPONSE =================
          return res.send({
            success: true,
            message: "Ticket resolved successfully",
            data: updatedTicket,
          });
        } catch (error) {
          console.error("Resolve ticket error:", error);

          return res.status(500).send({
            success: false,
            message: "Failed to resolve ticket",
          });
        }
      },
    );

    //==================== GET SUPPORT CONVERSATION ============================
    app.get(
      "/tickets/:ticketId/conversations",
      verifyFirebaseToken,
      async (req, res) => {
        try {
          const { ticketId } = req.params;

          if (!ObjectId.isValid(ticketId)) {
            return res.status(400).send({
              success: false,
              message: "Invalid ticket id",
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

          const currentAgentUid = getCurrentAgentUid(ticket.agentHistory || []);

          if (currentUser.role === "customer") {
            if (ticket.uid !== currentUser.uid) {
              return res.status(403).send({
                success: false,
                message: "You are not allowed to view this conversation",
              });
            }
          }

          if (currentUser.role === "agent") {
            const historyAgent = ticket.agentHistory?.find(
              (item) => item.uid === currentUser.uid,
            );

            const isCurrentAgent = currentAgentUid === currentUser.uid;

            if (!historyAgent && !isCurrentAgent) {
              return res.status(403).send({
                success: false,
                message: "You are not allowed to view this conversation",
              });
            }
          }

          if (
            currentUser.role !== "customer" &&
            currentUser.role !== "agent" &&
            currentUser.role !== "owner" &&
            currentUser.role !== "admin"
          ) {
            return res.status(403).send({
              success: false,
              message: "You are not allowed to view this conversation",
            });
          }

          const conversations = await supportConversations
            .find({
              ticketId: new ObjectId(ticketId),
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
          console.error("GET CONVERSATION ERROR:", error);

          return res.status(500).send({
            success: false,
            message: "Failed to fetch conversation",
          });
        }
      },
    );

    // ================= SEND SUPPORT MESSAGE =================
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

          if (!message || !message.trim()) {
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

          const ticket = await tickets.findOne({
            _id: new ObjectId(ticketId),
          });

          if (!ticket) {
            return res.status(404).send({
              success: false,
              message: "Ticket not found",
            });
          }

          const currentAgentUid = getCurrentAgentUid(ticket.agentHistory || []);

          if (currentUser.role === "customer") {
            if (ticket.uid !== currentUser.uid) {
              return res.status(403).send({
                success: false,
                message: "You are not allowed to send messages",
              });
            }
          }

          if (currentUser.role === "agent") {
            if (currentAgentUid !== currentUser.uid) {
              return res.status(403).send({
                success: false,
                message: "Only the current agent can send messages",
              });
            }
          }

          if (currentUser.role !== "customer" && currentUser.role !== "agent") {
            return res.status(403).send({
              success: false,
              message: "You are not allowed to send messages",
            });
          }

          const now = new Date();

          const conversationMessage = {
            ticketId: new ObjectId(ticketId),
            ticketNumber: ticket.ticketNumber,

            sender: {
              uid: currentUser.uid,
              role: currentUser.role,
              displayName:
                currentUser.displayName ||
                currentUser.name ||
                currentUser.email ||
                "User",
              email: currentUser.email,
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
            return res.status(400).send({
              success: false,
              message: "Message could not be sent",
            });
          }

          const ticketUpdate = {
            updatedAt: now,
          };

          if (currentUser.role === "agent" && ticket.status === "assigned") {
            ticketUpdate.status = "in_progress";
          }

          await tickets.updateOne(
            {
              _id: new ObjectId(ticketId),
            },
            {
              $set: ticketUpdate,
            },
          );

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
    // ================= DELETE CONVERSATION MESSAGE =================
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

          // ================= VALIDATION =================

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

          // ================= FIND TICKET =================

          const ticket = await tickets.findOne({
            _id: new ObjectId(ticketId),
          });

          if (!ticket) {
            return res.status(404).send({
              success: false,
              message: "Ticket not found",
            });
          }

          // ================= COMPANY SECURITY =================
          if (
            !ticket.companyId ||
            ticket.companyId.toString() !== req.agent.companyId.toString()
          ) {
            return res.status(403).send({
              success: false,
              message: "You don't have permission to access this ticket",
            });
          }

          // ================== ticket context ===============
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
          // ================= CURRENT ASSIGNED AGENT =================
          const currentAgentUid = getCurrentAgentUid(ticket.agentHistory || []);

          if (currentAgentUid && currentAgentUid !== req.agent.uid) {
            return res.status(403).send({
              success: false,
              message: "This ticket is assigned to another agent",
            });
          }

          // ================= CUSTOMER =================
          const customer = await users.findOne({
            uid: ticket.uid,
          });

          if (!customer) {
            return res.status(404).send({
              success: false,
              message: "Customer not found",
            });
          }

          // ================= CUSTOMER COMPANY =================

          let companyName = null;

          if (customer.companyId) {
            try {
              const company = await companies.findOne({
                _id: new ObjectId(customer.companyId),
              });

              companyName = company?.companyName || null;
            } catch {
              companyName = null;
            }
          }

          const customerContext = {
            uid: customer.uid || null,
            displayName: customer.displayName || "Customer",
            email: customer.email || null,
            role: customer.role || "customer",
            companyName: customer.companyName || null,
          };

          // ================= AGENT =================
          const agentContext = {
            uid: req.agent.uid,
            displayName: req.agent.displayName || "Support Agent",
            email: req.agent.email,
            role: "agent",
          };

          // ================= GET CHAT HISTORY =================
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

          // ================= AI =================
          const result = await suggestAgentReply({
            ticketContext,
            customerContext,
            agentContext,
            conversationHistory,
            agentDraft: typeof agentDraft === "string" ? agentDraft.trim() : "",
          });

          // ================= RESPONSE =================
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
