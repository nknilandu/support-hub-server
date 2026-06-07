const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const app = express();
const port = process.env.PORT || 3021;
const { MongoClient, ServerApiVersion } = require("mongodb");

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
const uri =
  `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster-support-hub.idvmsjp.mongodb.net/?appName=Cluster-Support-Hub`;

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
      const userBody = req.body;

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
      const result = await users.insertOne(userBody);

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
    });

    // ============== Create companies collection ==============
    app.post("/companies", async (req, res) => {
      const dataBody = req.body;
      const result = await companies.insertOne(dataBody);

      if (result.acknowledged) {
        return res.status(201).send({
          success: true,
          message: "Company added successfully",
          insertedId: result.insertedId,
        });
      }
      return res.status(400).send({
        success: false,
        message: "Company not added",
      });
    });

    // ============== Create companies collection ==============
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
        const ticketNumber = generateTicketNumber();
        const ticket = {
          ...bodyData,
          ticketNumber: ticketNumber,
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
          // ACTIVITY CHART (LAST 7 DAYS)
          // ==========================

          const sevenDaysAgo = new Date();
          sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);

          const activityAggregation = await tickets
            .aggregate([
              {
                $match: {
                  email,
                  createdAt: {
                    $gte: sevenDaysAgo,
                  },
                },
              },
              {
                $group: {
                  _id: {
                    $dateToString: {
                      format: "%Y-%m-%d",
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

          for (let i = 6; i >= 0; i--) {
            const date = new Date();
            date.setDate(date.getDate() - i);

            const dateString = date.toISOString().split("T")[0];
            const found = activityAggregation.find(
              (item) => item._id === dateString,
            );

            activityChart.push({
              day: date.toLocaleDateString("en-US", {
                weekday: "short",
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

    // ============================================= ================== =============================================

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

    // =================================

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
