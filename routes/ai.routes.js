const express = require("express");
const { ObjectId } = require("mongodb");

const { checkAiReplyLimit } = require("../utils/subscriptionLimits");

module.exports = function createAiRoutes({
  client,
  users,
  companies,
  tickets,
  aiConversations,
  aiMessages,
  verifyFirebaseToken,
  analyzeTicket,
  chatWithAssistant,
}) {
  const router = express.Router();

  // =====================================================
  // MIDDLEWARE: VERIFY WORKSPACE ACCESS FOR AI
  // =====================================================
  const verifyAiAccess = async (req, res, next) => {
    try {
      const user = await users.findOne({ uid: req.user.uid });

      if (!user) {
        return res
          .status(404)
          .send({ success: false, message: "User not found" });
      }

      if (user.status !== "active") {
        return res
          .status(403)
          .send({ success: false, message: "Your account is not active" });
      }

      if (!["customer", "agent", "manager"].includes(user.role)) {
        return res
          .status(403)
          .send({ success: false, message: "Workspace access required" });
      }

      if (user.role === "agent" && user.verifyIdAgent !== "approved") {
        return res
          .status(403)
          .send({ success: false, message: "Agent approval required" });
      }

      if (!user.companyId || !ObjectId.isValid(user.companyId)) {
        return res.status(403).send({
          success: false,
          message: "Your company information is invalid",
        });
      }

      const company = await companies.findOne(
        { _id: new ObjectId(user.companyId) },
        { projection: { _id: 1, status: 1 } },
      );

      if (!company || company.status !== "active") {
        return res
          .status(403)
          .send({ success: false, message: "Your company is not active" });
      }

      req.currentUser = user;
      next();
    } catch (error) {
      next(error);
    }
  };

  // =====================================================
  // 1. ANALYZE TICKET
  // POST /ai/analyze-ticket
  // =====================================================
  router.post(
    "/ai/analyze-ticket",
    verifyFirebaseToken,
    verifyAiAccess,
    async (req, res, next) => {
      try {
        const rawDescription = req.body?.description;
        const description =
          typeof rawDescription === "string"
            ? rawDescription.trim().slice(0, 10000)
            : "";

        if (!description) {
          return res
            .status(400)
            .send({ success: false, message: "Description is required" });
        }

        const aiLimitCheck = await checkAiReplyLimit({
          companies,
          tickets,
          companyId: req.currentUser.companyId,
        });

        if (!aiLimitCheck.allowed) {
          return res
            .status(403)
            .send({ success: false, message: aiLimitCheck.message });
        }

        const data = await analyzeTicket({ description });

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
  // 2. AI CHAT
  // POST /ai/chat
  // =====================================================
  router.post(
    "/ai/chat",
    verifyFirebaseToken,
    verifyAiAccess,
    async (req, res, next) => {
      try {
        const rawMessage = req.body?.message;
        const message =
          typeof rawMessage === "string"
            ? rawMessage.trim().slice(0, 10000)
            : "";

        if (!message) {
          return res
            .status(400)
            .send({ success: false, message: "Message is required" });
        }

        const aiLimitCheck = await checkAiReplyLimit({
          companies,
          tickets,
          companyId: req.currentUser.companyId,
        });

        if (!aiLimitCheck.allowed) {
          return res
            .status(403)
            .send({ success: false, message: aiLimitCheck.message });
        }

        const uid = req.user.uid;

        const requestedId = req.body?.conversationId;
        let conversation = null;

        if (requestedId) {
          if (
            typeof requestedId !== "string" ||
            !ObjectId.isValid(requestedId)
          ) {
            return res
              .status(400)
              .send({ success: false, message: "Invalid conversation ID" });
          }

          conversation = await aiConversations.findOne({
            _id: new ObjectId(requestedId),
            uid,
          });

          if (!conversation) {
            return res
              .status(404)
              .send({ success: false, message: "Conversation not found" });
          }
        }

        const isNew = !conversation;
        const conversationId = conversation?._id || new ObjectId();

        const historyDocs = isNew
          ? []
          : await aiMessages
              .find({ conversationId })
              .sort({ createdAt: -1, _id: -1 })
              .limit(10)
              .toArray();

        const history = historyDocs.reverse().map((item) => ({
          role: item.sender === "ai" ? "assistant" : "user",
          content: item.message,
        }));

        const result = await chatWithAssistant({
          message,
          history,
          userContext: {
            user: req.currentUser,
          },
        });

        if (typeof result?.reply !== "string" || !result.reply.trim()) {
          return res
            .status(502)
            .send({ success: false, message: "AI returned an empty response" });
        }

        const now = new Date();

        const userMessage = {
          _id: new ObjectId(),
          conversationId,
          sender: "user",
          message,
          createdAt: now,
        };

        const aiMessage = {
          _id: new ObjectId(),
          conversationId,
          sender: "ai",
          message: result.reply,
          meta: {
            mode: result.mode,
            intent: result.intent,
            severity: result.severity,
            tokensUsed: result.meta?.tokensUsed,
            model: result.meta?.model,
          },
          createdAt: now,
        };

        const session = client.startSession();
        try {
          await session.withTransaction(async () => {
            // Re-check user & company inside transaction
            const freshUser = await users.findOne({ uid }, { session });
            if (
              !freshUser ||
              freshUser.status !== "active" ||
              !["customer", "agent", "manager"].includes(freshUser.role) ||
              (freshUser.role === "agent" &&
                freshUser.verifyIdAgent !== "approved") ||
              !freshUser.companyId ||
              !ObjectId.isValid(freshUser.companyId)
            ) {
              const err = new Error("Workspace access denied");
              err.status = 403;
              throw err;
            }

            const freshCompany = await companies.findOne(
              { _id: new ObjectId(freshUser.companyId) },
              { session, projection: { _id: 1, status: 1 } },
            );

            if (!freshCompany || freshCompany.status !== "active") {
              const err = new Error("Your company is not active");
              err.status = 403;
              throw err;
            }

            if (isNew) {
              await aiConversations.insertOne(
                {
                  _id: conversationId,
                  uid,
                  preview: result.preview || result.reply.slice(0, 60),
                  details: result.details || result.reply.slice(0, 120),
                  createdAt: now,
                  updatedAt: now,
                },
                { session },
              );
            } else {
              const updated = await aiConversations.updateOne(
                { _id: conversationId, uid },
                {
                  $set: {
                    updatedAt: now,
                    lastMessageId: aiMessage._id,
                  },
                },
                { session },
              );

              if (!updated.matchedCount) {
                const err = new Error("Conversation changed");
                err.status = 409;
                throw err;
              }
            }

            await aiMessages.insertMany([userMessage, aiMessage], { session });
          });
        } finally {
          await session.endSession();
        }

        return res.send({
          success: true,
          conversationId: String(conversationId),
          data: result,
          messages: {
            user: userMessage,
            ai: aiMessage,
          },
        });
      } catch (error) {
        next(error);
      }
    },
  );

  // =====================================================
  // 3. MY AI CONVERSATIONS
  // GET /ai/conversations
  // =====================================================
  router.get(
    "/ai/conversations",
    verifyFirebaseToken,
    verifyAiAccess,
    async (req, res, next) => {
      try {
        const rawPage = Number(req.query.page);
        const page =
          Number.isSafeInteger(rawPage) && rawPage > 0
            ? Math.min(rawPage, 1000000)
            : 1;

        const rawLimit = Number(req.query.limit);
        const limit =
          Number.isSafeInteger(rawLimit) && rawLimit > 0
            ? Math.min(rawLimit, 100)
            : 30;

        const query = { uid: req.user.uid };

        const search =
          typeof req.query.search === "string"
            ? req.query.search.trim().slice(0, 200)
            : "";

        if (search) {
          const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const regex = new RegExp(escaped, "i");
          query.$or = [{ preview: regex }, { details: regex }];
        }

        const [total, data] = await Promise.all([
          aiConversations.countDocuments(query),
          aiConversations
            .find(query, {
              projection: {
                preview: 1,
                details: 1,
                updatedAt: 1,
              },
            })
            .sort({ updatedAt: -1, _id: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .toArray(),
        ]);

        return res.send({
          success: true,
          data,
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
  // 4. MY AI CONVERSATION MESSAGES
  // GET /ai/conversations/:conversationId/messages
  // =====================================================
  router.get(
    "/ai/conversations/:conversationId/messages",
    verifyFirebaseToken,
    verifyAiAccess,
    async (req, res, next) => {
      try {
        const { conversationId } = req.params;
        if (!ObjectId.isValid(conversationId)) {
          return res
            .status(400)
            .send({ success: false, message: "Invalid conversation ID" });
        }

        const oid = new ObjectId(conversationId);
        const conversation = await aiConversations.findOne({
          _id: oid,
          uid: req.user.uid,
        });

        if (!conversation) {
          return res
            .status(404)
            .send({ success: false, message: "Conversation not found" });
        }

        const data = await aiMessages
          .find({ conversationId: oid })
          .sort({ createdAt: 1, _id: 1 })
          .toArray();

        return res.send({
          success: true,
          conversation,
          data,
        });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
};
