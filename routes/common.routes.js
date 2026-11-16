const express = require("express");
const { ObjectId } = require("mongodb");

module.exports = function createCommonRoutes({
  client,
  users,
  companies,
  tickets,
  notifications,
  supportConversations,
  verifyFirebaseToken,
}) {
  const router = express.Router();

  // =====================================================
  // ACTIVE USER
  // Pending agents can access their own profile/notifications.
  // Agent work requires a separate approval check.
  // =====================================================

  const activeUser = async (req, res, next) => {
    try {
      const user = await users.findOne({
        uid: req.user.uid,
      });

      if (!user) {
        return res.status(404).send({
          success: false,
          message: "User not found",
        });
      }

      if (user.status !== "active") {
        return res.status(403).send({
          success: false,
          message: "Your account is not active",
        });
      }

      req.currentUser = user;
    } catch (error) {
      return next(error);
    }

    next();
  };

  // =====================================================
  // NOTIFICATION CREATOR
  // Supports:
  // createNotification({ ..., session })
  // createNotification({ ... }, session)
  // =====================================================

  const createNotification = async (
    {
      uid,
      userEmail = null,
      companyId = null,
      title,
      message,
      type = "general",
      ticketId = null,
      ticketNumber = null,
      messageId = null,
      path = "/",
      session = null,
    },
    transactionSession = null,
  ) => {
    if (typeof uid !== "string" || !uid.trim()) {
      throw new Error("Notification recipient uid is required");
    }

    if (typeof title !== "string" || !title.trim()) {
      throw new Error("Notification title is required");
    }

    if (typeof message !== "string" || !message.trim()) {
      throw new Error("Notification message is required");
    }

    if (typeof type !== "string" || !type.trim()) {
      throw new Error("Notification type is required");
    }

    const safePath =
      typeof path === "string" &&
      path.startsWith("/") &&
      !path.startsWith("//") &&
      !/[\s\\\u0000-\u001f\u007f]/.test(path)
        ? path
        : "/";

    const notification = {
      uid: uid.trim(),

      userEmail:
        typeof userEmail === "string" ? userEmail.trim() || null : null,

      companyId:
        companyId && ObjectId.isValid(companyId)
          ? new ObjectId(companyId)
          : null,

      title: title.trim(),
      message: message.trim(),
      type: type.trim(),

      ticketId:
        ticketId && ObjectId.isValid(ticketId) ? new ObjectId(ticketId) : null,

      ticketNumber,

      messageId:
        messageId && ObjectId.isValid(messageId)
          ? new ObjectId(messageId)
          : null,

      path: safePath,
      isRead: false,
      readAt: null,
      createdAt: new Date(),
    };

    const dbSession = transactionSession || session;

    const result = await notifications.insertOne(
      notification,
      dbSession ? { session: dbSession } : {},
    );

    return {
      ...notification,
      _id: result.insertedId,
    };
  };

  // =====================================================
  // 1. REGISTER USER
  // POST /users
  // =====================================================

  router.post("/users", verifyFirebaseToken, async (req, res, next) => {
    try {
      const uid = req.user.uid;

      // Identity comes from Firebase, not the request body.
      const email =
        typeof req.user.email === "string"
          ? req.user.email.trim().toLowerCase()
          : "";

      if (!email) {
        return res.status(400).send({
          success: false,
          message: "An email address is required",
        });
      }

      const existingUser = await users.findOne({ uid });

      if (existingUser) {
        return res.send({
          success: true,
          message: "User already exists",
          existing: true,
          insertedId: existingUser._id,
        });
      }

      const role = req.body?.role === "owner" ? "manager" : req.body?.role;

      if (!["customer", "agent", "manager"].includes(role)) {
        return res.status(400).send({
          success: false,
          message: "Invalid registration role",
        });
      }

      let company = null;

      if (role === "manager") {
        // Public signup cannot grant management access
        // to an existing company.
        if (req.body?.companyId) {
          return res.status(403).send({
            success: false,
            message:
              "Joining an existing company as a manager requires an invitation",
          });
        }
      } else {
        const companyId = req.body?.companyId;

        if (
          typeof companyId !== "string" ||
          !/^[a-f\d]{24}$/i.test(companyId)
        ) {
          return res.status(400).send({
            success: false,
            message: "A valid company ID is required",
          });
        }

        company = await companies.findOne({
          _id: new ObjectId(companyId),
          status: "active",
        });

        if (!company) {
          return res.status(400).send({
            success: false,
            message: "Selected company is unavailable",
          });
        }
      }

      const displayName =
        typeof req.body?.displayName === "string"
          ? req.body.displayName.trim()
          : typeof req.user.name === "string"
            ? req.user.name.trim()
            : "";

      if (!displayName || displayName.length > 200) {
        return res.status(400).send({
          success: false,
          message: "Display name must contain 1 to 200 characters",
        });
      }

      const photoURL =
        typeof req.body?.photoURL === "string"
          ? req.body.photoURL.trim()
          : typeof req.user.picture === "string"
            ? req.user.picture.trim()
            : "";

      if (photoURL.length > 2048) {
        return res.status(400).send({
          success: false,
          message: "Photo URL is too long",
        });
      }

      const now = new Date();

      const user = {
        uid,
        email,
        displayName,
        photoURL: photoURL || null,
        role,
        status: "active",

        verifyIdAgent: role === "agent" ? "pending" : "approved",

        companyId: company ? String(company._id) : null,
        companyName: company?.companyName || null,

        createdAt: now,
        updatedAt: now,
      };

      // Repeat registration must not overwrite
      // role, company or approval.
      const result = await users.updateOne(
        { uid },
        { $setOnInsert: user },
        { upsert: true },
      );

      const savedUser = await users.findOne(
        { uid },
        { projection: { _id: 1 } },
      );

      return res.status(result.upsertedCount ? 201 : 200).send({
        success: true,
        message: result.upsertedCount
          ? "User created successfully"
          : "User already exists",
        existing: !result.upsertedCount,
        insertedId: savedUser._id,
      });
    } catch (error) {
      if (error.code === 11000) {
        try {
          const existingUser = await users.findOne({
            uid: req.user.uid,
          });

          if (existingUser) {
            return res.send({
              success: true,
              message: "User already exists",
              existing: true,
              insertedId: existingUser._id,
            });
          }

          return res.status(409).send({
            success: false,
            message: "An account with these details already exists",
          });
        } catch (lookupError) {
          return next(lookupError);
        }
      }

      next(error);
    }
  });

  // =====================================================
  // 2. CREATE MANAGER'S COMPANY
  // POST /companies
  // Company names are unique across all statuses.
  // =====================================================

  router.post(
    "/companies",
    verifyFirebaseToken,
    activeUser,
    async (req, res, next) => {
      if (!["manager", "owner"].includes(req.currentUser.role)) {
        return res.status(403).send({
          success: false,
          message: "Only a workplace manager can create a company",
        });
      }

      const companyName =
        typeof req.body?.companyName === "string"
          ? req.body.companyName.trim().toLowerCase()
          : "";

      if (!companyName || companyName.length > 200) {
        return res.status(400).send({
          success: false,
          message: "Company name must contain 1 to 200 characters",
        });
      }

      const companyLogo =
        typeof req.body?.companyLogo === "string"
          ? req.body.companyLogo.trim()
          : "";

      if (companyLogo.length > 2048) {
        return res.status(400).send({
          success: false,
          message: "Company logo URL is too long",
        });
      }

      const session = client.startSession();

      try {
        let company;
        let created;

        await session.withTransaction(async () => {
          created = false;
          company = null;

          const user = await users.findOne({ uid: req.user.uid }, { session });

          if (
            !user ||
            user.status !== "active" ||
            !["manager", "owner"].includes(user.role)
          ) {
            throw Object.assign(new Error("Active manager access required"), {
              status: 403,
            });
          }

          // Repeated requests return the existing company.
          if (user.companyId) {
            if (!ObjectId.isValid(user.companyId)) {
              throw Object.assign(
                new Error("Your company information is invalid"),
                { status: 409 },
              );
            }

            company = await companies.findOne(
              { _id: new ObjectId(user.companyId) },
              { session },
            );

            if (!company) {
              throw Object.assign(
                new Error("Your linked company was not found"),
                { status: 409 },
              );
            }
          } else {
            // Compatibility with older company records.
            const existingCompanies = await companies
              .find(
                {
                  $or: [
                    { primaryManagerUid: user.uid },
                    { ownerUid: user.uid },
                  ],
                },
                { session },
              )
              .limit(2)
              .toArray();

            if (existingCompanies.length > 1) {
              throw Object.assign(
                new Error("Multiple company records require review"),
                { status: 409 },
              );
            }

            company = existingCompanies[0] || null;
          }

          if (company && company.status !== "active") {
            throw Object.assign(new Error("Your company is not active"), {
              status: 403,
            });
          }

          const now = new Date();

          if (!company) {
            const duplicate = await companies.findOne(
              { companyName },
              {
                session,
                collation: {
                  locale: "en",
                  strength: 2,
                },
                projection: { _id: 1 },
              },
            );

            if (duplicate) {
              throw Object.assign(
                new Error("This company name is already registered"),
                { status: 409 },
              );
            }

            company = {
              _id: new ObjectId(),
              companyName,
              companyLogo: companyLogo || null,

              primaryManagerUid: user.uid,

              // Existing-schema compatibility.
              ownerUid: user.uid,
              ownerId: user._id,

              status: "active",
              createdAt: now,
              updatedAt: now,
            };

            // Unique index protects concurrent requests.
            await companies.insertOne(company, { session });
            created = true;
          }

          // Company creation and user linkage commit together.
          await users.updateOne(
            { _id: user._id },
            {
              $set: {
                companyId: String(company._id),
                companyName: company.companyName,
                updatedAt: now,
              },
            },
            { session },
          );
        });

        return res.status(created ? 201 : 200).send({
          success: true,
          message: created
            ? "Company created successfully"
            : "Company already exists",
          existing: !created,
          insertedId: company._id,
          company,
        });
      } catch (error) {
        if (
          error.code === 11000 &&
          (error.keyPattern?.companyName ||
            error.message?.includes("unique_company_name"))
        ) {
          return res.status(409).send({
            success: false,
            message: "This company name is already registered",
          });
        }

        next(error);
      } finally {
        await session.endSession();
      }
    },
  );

  // =====================================================
  // 3. ACTIVE COMPANIES
  // GET /companies
  // Public registration dropdown.
  // =====================================================

  router.get("/companies", async (req, res, next) => {
    try {
      const data = await companies
        .find(
          { status: "active" },
          {
            projection: {
              _id: 1,
              companyName: 1,
              companyLogo: 1,
              status: 1,
            },
          },
        )
        .sort({ companyName: 1, _id: 1 })
        .toArray();

      return res.send(data);
    } catch (error) {
      next(error);
    }
  });

  // =====================================================
  // 4. CURRENT USER
  // GET /users/me
  // Inactive users can also read their account status.
  // =====================================================

  router.get("/users/me", verifyFirebaseToken, async (req, res, next) => {
    try {
      const user = await users.findOne({
        uid: req.user.uid,
      });

      if (!user) {
        return res.status(404).send({
          success: false,
          message: "User not found",
        });
      }

      let company = null;

      if (user.companyId && ObjectId.isValid(user.companyId)) {
        company = await companies.findOne(
          { _id: new ObjectId(user.companyId) },
          {
            projection: {
              _id: 1,
              companyName: 1,
              companyLogo: 1,
              status: 1,
            },
          },
        );
      }

      return res.send({
        success: true,
        user,
        company,
      });
    } catch (error) {
      next(error);
    }
  });

  // =====================================================
  // 5. UPDATE MY PROFILE
  // PATCH /users/me
  // No role, company, email, status or approval updates.
  // =====================================================

  router.patch(
    "/users/me",
    verifyFirebaseToken,
    activeUser,
    async (req, res, next) => {
      try {
        const allowedFields = {
          displayName: 200,
          photoURL: 2048,
          phone: 40,
          location: 200,
          language: 100,
          timezone: 100,
        };

        const updates = {};

        for (const [field, maxLength] of Object.entries(allowedFields)) {
          if (!Object.prototype.hasOwnProperty.call(req.body || {}, field)) {
            continue;
          }

          if (typeof req.body[field] !== "string") {
            return res.status(400).send({
              success: false,
              message: `${field} must be a string`,
            });
          }

          const value = req.body[field].trim();

          if (value.length > maxLength) {
            return res.status(400).send({
              success: false,
              message: `${field} must be at most ${maxLength} characters`,
            });
          }

          if (field === "displayName" && !value) {
            return res.status(400).send({
              success: false,
              message: "Display name is required",
            });
          }

          updates[field] = value;
        }

        if (!Object.keys(updates).length) {
          return res.status(400).send({
            success: false,
            message: "No supported profile fields provided",
          });
        }

        updates.updatedAt = new Date();

        const result = await users.updateOne(
          {
            uid: req.user.uid,
            status: "active",
          },
          { $set: updates },
        );

        if (!result.matchedCount) {
          return res.status(403).send({
            success: false,
            message: "Your account is no longer active",
          });
        }

        return res.send({
          success: true,
          message: "Profile updated successfully",
          modifiedCount: result.modifiedCount,
        });
      } catch (error) {
        next(error);
      }
    },
  );

  // =====================================================
  // CONVERSATION ACCESS
  // Approval is required here for agents.
  // =====================================================

  const checkConversationAccess = async ({
    uid,
    ticketId,
    write = false,
    session = null,
  }) => {
    const options = session ? { session } : {};

    const user = await users.findOne({ uid }, options);

    if (!user) {
      throw Object.assign(new Error("User not found"), {
        status: 404,
      });
    }

    if (user.status !== "active") {
      throw Object.assign(new Error("Your account is not active"), {
        status: 403,
      });
    }

    const role = user.role === "owner" ? "manager" : user.role;

    const allowedRoles = write
      ? ["customer", "agent"]
      : ["customer", "agent", "manager"];

    if (!allowedRoles.includes(role)) {
      throw Object.assign(
        new Error(
          write
            ? "You are not allowed to send support messages"
            : "You are not allowed to view this conversation",
        ),
        { status: 403 },
      );
    }

    if (role === "agent" && user.verifyIdAgent !== "approved") {
      throw Object.assign(
        new Error("Your agent account requires manager approval"),
        { status: 403 },
      );
    }

    if (!user.companyId || !ObjectId.isValid(user.companyId)) {
      throw Object.assign(new Error("Your company information is invalid"), {
        status: 403,
      });
    }

    const companyId = new ObjectId(user.companyId);

    const company = await companies.findOne(
      {
        _id: companyId,
        status: "active",
      },
      {
        ...options,
        projection: { _id: 1 },
      },
    );

    if (!company) {
      throw Object.assign(new Error("Your company is not active"), {
        status: 403,
      });
    }

    const query = {
      _id: ticketId,
      companyId,
    };

    if (role === "customer") {
      query.uid = user.uid;
    }

    if (role === "agent") {
      query["currentAgent.uid"] = user.uid;
    }

    const ticket = await tickets.findOne(query, options);

    if (!ticket) {
      throw Object.assign(new Error("Ticket not found"), {
        status: 404,
      });
    }

    if (ticket.aiResolved === true) {
      throw Object.assign(
        new Error("AI-resolved tickets do not support this conversation"),
        { status: 409 },
      );
    }

    const allowedStatuses = write
      ? ["assigned", "in_progress"]
      : ["assigned", "in_progress", "resolved", "closed"];

    if (!allowedStatuses.includes(ticket.status)) {
      throw Object.assign(
        new Error(
          write
            ? "You cannot send messages in the current ticket status"
            : "Conversation is unavailable in the current ticket status",
        ),
        { status: 409 },
      );
    }

    if (write && !ticket.currentAgent?.uid) {
      throw Object.assign(
        new Error("An assigned agent is required to send messages"),
        { status: 409 },
      );
    }

    return {
      user,
      role,
      ticket,
      companyId,
    };
  };

  // =====================================================
  // 6. READ SUPPORT CONVERSATION
  // GET /tickets/:ticketId/conversations
  // =====================================================

  router.get(
    "/tickets/:ticketId/conversations",
    verifyFirebaseToken,
    async (req, res, next) => {
      try {
        if (!/^[a-f\d]{24}$/i.test(req.params.ticketId)) {
          return res.status(400).send({
            success: false,
            message: "Invalid ticket ID",
          });
        }

        const { ticket } = await checkConversationAccess({
          uid: req.user.uid,
          ticketId: new ObjectId(req.params.ticketId),
        });

        const data = await supportConversations
          .find(
            {
              ticketId: ticket._id,
              visibility: { $ne: "internal" },
            },
            {
              projection: {
                _id: 1,
                ticketId: 1,
                ticketNumber: 1,
                "sender.uid": 1,
                "sender.role": 1,
                "sender.displayName": 1,
                "sender.email": 1,
                "sender.photoURL": 1,
                message: 1,
                type: 1,
                attachments: 1,
                createdAt: 1,
                updatedAt: 1,
              },
            },
          )
          .sort({ createdAt: 1, _id: 1 })
          .toArray();

        return res.send({
          success: true,
          data,
        });
      } catch (error) {
        next(error);
      }
    },
  );

  // =====================================================
  // 7. SEND SUPPORT MESSAGE
  // POST /tickets/:ticketId/conversations
  // =====================================================

  router.post(
    "/tickets/:ticketId/conversations",
    verifyFirebaseToken,
    async (req, res, next) => {
      if (!/^[a-f\d]{24}$/i.test(req.params.ticketId)) {
        return res.status(400).send({
          success: false,
          message: "Invalid ticket ID",
        });
      }

      const message =
        typeof req.body?.message === "string" ? req.body.message.trim() : "";

      if (!message || message.length > 10000) {
        return res.status(400).send({
          success: false,
          message: "Message must contain 1 to 10000 characters",
        });
      }

      const session = client.startSession();

      try {
        const ticketId = new ObjectId(req.params.ticketId);
        let savedMessage;

        await session.withTransaction(
          async () => {
            const { user, role, ticket, companyId } =
              await checkConversationAccess({
                uid: req.user.uid,
                ticketId,
                write: true,
                session,
              });

            const now = new Date();
            const messageId = new ObjectId();

            const isFirstAgentReply =
              role === "agent" && ticket.status === "assigned";

            const filter = {
              _id: ticket._id,
              companyId,
              status: ticket.status,
              aiResolved: { $ne: true },
              "currentAgent.uid": ticket.currentAgent.uid,
            };

            if (role === "customer") {
              filter.uid = user.uid;
            } else {
              filter["currentAgent.uid"] = user.uid;
            }

            const update = {
              $set: {
                updatedAt: now,
                lastMessageId: messageId,
              },
            };

            if (isFirstAgentReply) {
              update.$set.status = "in_progress";

              update.$push = {
                actionHistory: {
                  uid: user.uid,
                  role: "agent",
                  action: "in_progress",
                  date: now,
                },
              };
            }

            const ticketUpdate = await tickets.updateOne(filter, update, {
              session,
            });

            if (ticketUpdate.matchedCount !== 1) {
              throw Object.assign(
                new Error("Ticket changed. Please refresh and try again."),
                { status: 409 },
              );
            }

            savedMessage = {
              _id: messageId,
              ticketId: ticket._id,
              ticketNumber: ticket.ticketNumber,

              sender: {
                uid: user.uid,
                role,
                displayName:
                  user.displayName || user.name || user.email || "User",
                email: user.email || null,
                photoURL: user.photoURL || null,
              },

              message,
              type: "text",
              attachments: [],
              visibility: "public",
              createdAt: now,
              updatedAt: now,
            };

            await supportConversations.insertOne(savedMessage, { session });

            const fromAgent = role === "agent";

            const recipientUid = fromAgent
              ? ticket.uid
              : ticket.currentAgent.uid;

            if (typeof recipientUid !== "string" || !recipientUid.trim()) {
              throw Object.assign(
                new Error("Ticket recipient information is invalid"),
                { status: 409 },
              );
            }

            if (recipientUid !== user.uid) {
              await createNotification({
                uid: recipientUid,
                companyId,

                title: fromAgent ? "New Support Reply" : "New Customer Message",

                message: fromAgent
                  ? `You received a new reply on ticket ${ticket.ticketNumber}.`
                  : `The customer sent a message on ticket ${ticket.ticketNumber}.`,

                type: fromAgent ? "agent_reply" : "customer_reply",

                ticketId: ticket._id,
                ticketNumber: ticket.ticketNumber,
                messageId,

                path: fromAgent
                  ? `/customer/tickets/${ticket._id}`
                  : `/agent/tickets/${ticket._id}`,

                session,
              });
            }
          },
          {
            readConcern: { level: "snapshot" },
            writeConcern: { w: "majority" },
          },
        );

        return res.status(201).send({
          success: true,
          message: "Message sent successfully",
          data: savedMessage,
        });
      } catch (error) {
        next(error);
      } finally {
        await session.endSession();
      }
    },
  );

  // =====================================================
  // 8. MY NOTIFICATIONS
  // GET /notifications?page=1&limit=20
  // =====================================================

  router.get(
    "/notifications",
    verifyFirebaseToken,
    activeUser,
    async (req, res, next) => {
      try {
        const rawLimit = Number(req.query.limit);
        const rawPage = Number(req.query.page);

        const limit =
          Number.isSafeInteger(rawLimit) && rawLimit > 0
            ? Math.min(rawLimit, 100)
            : 20;

        const page =
          Number.isSafeInteger(rawPage) && rawPage > 0
            ? Math.min(rawPage, 1000000)
            : 1;

        const query = {
          uid: req.currentUser.uid,
        };

        const [data, unreadCount, total] = await Promise.all([
          notifications
            .find(query)
            .sort({ createdAt: -1, _id: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .toArray(),

          notifications.countDocuments({
            ...query,
            isRead: false,
          }),

          notifications.countDocuments(query),
        ]);

        return res.send({
          success: true,
          unreadCount,
          notifications: data,
          pagination: {
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
          },
        });
      } catch (error) {
        next(error);
      }
    },
  );

  // =====================================================
  // 9. READ ALL MY NOTIFICATIONS
  // PATCH /notifications/read-all
  // Keep before /notifications/:id.
  // =====================================================

  router.patch(
    "/notifications/read-all",
    verifyFirebaseToken,
    activeUser,
    async (req, res, next) => {
      try {
        const result = await notifications.updateMany(
          {
            uid: req.currentUser.uid,
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
        next(error);
      }
    },
  );

  // =====================================================
  // 10. READ ONE NOTIFICATION
  // PATCH /notifications/:id
  // =====================================================

  router.patch(
    "/notifications/:id",
    verifyFirebaseToken,
    activeUser,
    async (req, res, next) => {
      try {
        if (!/^[a-f\d]{24}$/i.test(req.params.id)) {
          return res.status(400).send({
            success: false,
            message: "Invalid notification ID",
          });
        }

        const query = {
          _id: new ObjectId(req.params.id),
          uid: req.currentUser.uid,
        };

        const notification = await notifications.findOne(query, {
          projection: {
            _id: 1,
            isRead: 1,
          },
        });

        if (!notification) {
          return res.status(404).send({
            success: false,
            message: "Notification not found",
          });
        }

        if (notification.isRead === true) {
          return res.send({
            success: true,
            modifiedCount: 0,
          });
        }

        const result = await notifications.updateOne(
          {
            ...query,
            isRead: { $ne: true },
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
        next(error);
      }
    },
  );

  return {
    router,
    createNotification,
  };
};
