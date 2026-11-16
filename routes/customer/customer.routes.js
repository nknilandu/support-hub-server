const express = require("express");
const crypto = require("crypto");
const { ObjectId } = require("mongodb");

module.exports = function createCustomerRoutes({
  users,
  companies,
  tickets,
  verifyFirebaseToken,
  createNotification,
}) {
  const router = express.Router();

  // =========================================================
  // HELPERS
  // =========================================================

  const fail = (res, status, message) => {
    return res.status(status).send({
      success: false,
      message,
    });
  };

  const asyncHandler = (handler) => {
    return async (req, res, next) => {
      try {
        await handler(req, res, next);
      } catch (error) {
        console.error(
          `Customer API error: ${req.method} ${req.originalUrl}`,
          error,
        );

        if (!res.headersSent) {
          return fail(res, 500, "Something went wrong. Please try again.");
        }

        next(error);
      }
    };
  };

  const isRecord = (value) => {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  };

  const escapeRegex = (value) => {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  };

  const queryText = (value, maxLength = 200) => {
    return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
  };

  const positiveInteger = (value, fallback, maximum) => {
    const number = typeof value === "string" ? Number(value) : NaN;

    if (!Number.isSafeInteger(number) || number < 1) {
      return fallback;
    }

    return Math.min(number, maximum);
  };

  const generateTicketNumber = () => {
    const timePart = Date.now().toString(16).toUpperCase();
    const randomPart = crypto.randomBytes(4).toString("hex").toUpperCase();

    return `TCK-${timePart}${randomPart}`;
  };

  // Notification failure must not undo a successful ticket action.
  const notify = async (notification) => {
    try {
      await createNotification(notification);
    } catch (error) {
      console.error("Customer notification error:", error.message);
    }
  };

  const hasSupportHistory = (ticket) => {
    return (ticket.actionHistory || []).some(
      (item) =>
        item.role === "agent" ||
        ["ai_resolved", "reopened", "closed"].includes(item.action),
    );
  };

  const canDeleteTicket = (ticket) => {
    return (
      ticket.status === "open" &&
      ticket.aiResolved !== true &&
      !ticket.currentAgent?.uid &&
      !ticket.resolvedBy?.uid &&
      !hasSupportHistory(ticket)
    );
  };

  const getPermission = (ticket) => {
    return {
      canRead: true,

      canReadMessages:
        ticket.aiResolved !== true &&
        ["assigned", "in_progress", "resolved", "closed"].includes(
          ticket.status,
        ),

      canSendMessage:
        ticket.aiResolved !== true &&
        ["assigned", "in_progress"].includes(ticket.status),

      canClose: ticket.status === "resolved",
      canReopen: ticket.status === "resolved",
      canDelete: canDeleteTicket(ticket),
    };
  };

  const formatAgent = (agent) => {
    if (!agent?.uid) return null;

    return {
      uid: agent.uid,
      displayName: agent.displayName || agent.name || null,
      email: agent.email || null,
      photoURL: agent.photoURL || null,
      role: agent.role || "agent",
      status: agent.status || null,
    };
  };

  const agentProjection = {
    _id: 0,
    uid: 1,
    displayName: 1,
    name: 1,
    email: 1,
    photoURL: 1,
    role: 1,
    status: 1,
  };

  // =========================================================
  // CUSTOMER AUTHORIZATION
  //
  // Applied to individual routes, NOT router.use().
  // Otherwise unrelated agent/common routes could be blocked.
  // =========================================================

  const verifyCustomer = asyncHandler(async (req, res, next) => {
    const customer = await users.findOne({
      uid: req.user.uid,
    });

    if (!customer) {
      return fail(res, 404, "User not found");
    }

    if (customer.role !== "customer") {
      return fail(res, 403, "Customer access required");
    }

    if (customer.status !== "active") {
      return fail(res, 403, "Your account is not active");
    }

    if (!customer.companyId || !ObjectId.isValid(customer.companyId)) {
      return fail(res, 403, "Your account is not connected to a company");
    }

    const companyId = new ObjectId(customer.companyId);

    const company = await companies.findOne(
      { _id: companyId },
      { projection: { _id: 1, status: 1 } },
    );

    if (!company) {
      return fail(res, 403, "Your company was not found");
    }

    if (company.status !== "active") {
      return fail(res, 403, "Your company is not active");
    }

    req.customer = customer;
    req.customerCompanyId = companyId;

    next();
  });

  const customerAuth = [verifyFirebaseToken, verifyCustomer];

  // All customer ticket queries are scoped to both identity and company.
  const customerScope = (req) => ({
    uid: req.customer.uid,
    companyId: req.customerCompanyId,
  });

  const loadCustomerTicket = asyncHandler(async (req, res, next) => {
    const { ticketId } = req.params;

    if (!ObjectId.isValid(ticketId)) {
      return fail(res, 400, "Invalid ticket ID");
    }

    const ticket = await tickets.findOne({
      _id: new ObjectId(ticketId),
      ...customerScope(req),
    });

    // Do not disclose another customer's ticket existence.
    if (!ticket) {
      return fail(res, 404, "Ticket not found");
    }

    req.customerTicket = ticket;
    next();
  });

  // =========================================================
  // 1. CREATE TICKET
  // POST /tickets
  // =========================================================

  router.post(
    "/tickets",
    ...customerAuth,
    asyncHandler(async (req, res) => {
      const { ticketData, aiResult, resolutionType } = req.body || {};

      if (!isRecord(ticketData) || !isRecord(aiResult)) {
        return fail(res, 400, "Valid ticketData and aiResult are required");
      }

      if (!["ai", "human"].includes(resolutionType)) {
        return fail(res, 400, "Invalid resolution type");
      }

      const now = new Date();
      const isAiResolved = resolutionType === "ai";
      const ticketNumber = generateTicketNumber();

      const ticket = {
        supportMode: isAiResolved ? "ai" : "human",
        resolutionSource: isAiResolved ? "ai" : null,
        aiResolved: isAiResolved,
        escalatedToHuman: !isAiResolved,

        ticketData,
        aiResult,

        uid: req.customer.uid,
        companyId: req.customerCompanyId,
        ticketNumber,

        status: isAiResolved ? "resolved" : "open",

        currentAgent: null,
        resolvedBy: null,
        resolvedAt: isAiResolved ? now : null,

        actionHistory: [
          {
            uid: req.customer.uid,
            role: "customer",
            action: "created",
            date: now,
          },

          ...(isAiResolved
            ? [
                {
                  uid: req.customer.uid,
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

      await notify({
        uid: req.customer.uid,
        userEmail: req.customer.email,

        title: isAiResolved
          ? "Ticket Resolved by AI"
          : "Ticket Created Successfully",

        message: isAiResolved
          ? `Your ticket ${ticketNumber} has been resolved by AI.`
          : `Your ticket ${ticketNumber} has been created. Our team will review it shortly.`,

        type: isAiResolved ? "ticket_resolved" : "ticket_created",
        ticketId: result.insertedId,
        ticketNumber,
        path: `/customer/tickets/${result.insertedId}`,
      });

      return res.status(201).send({
        success: true,
        message: isAiResolved
          ? "Ticket resolved by AI"
          : "Ticket created successfully",
        id: result.insertedId,
        ticketNumber,
      });
    }),
  );

  // =========================================================
  // 2. MY TICKETS
  // GET /tickets/my-tickets
  // =========================================================

  router.get(
    "/tickets/my-tickets",
    ...customerAuth,
    asyncHandler(async (req, res) => {
      const search = queryText(req.query.search);
      const status = queryText(req.query.status, 40);
      const priority = queryText(req.query.priority, 40);
      const category = queryText(req.query.category, 80);

      const page = positiveInteger(req.query.page, 1, 1000000);
      const limit = positiveInteger(req.query.limit, 10, 100);
      const skip = (page - 1) * limit;

      const query = customerScope(req);

      if (search) {
        const searchRegex = new RegExp(escapeRegex(search), "i");

        query.$or = [
          { ticketNumber: searchRegex },
          { "aiResult.ticketTitle": searchRegex },
          { "aiResult.summary": searchRegex },
        ];
      }

      if (status) {
        query.status = new RegExp(`^${escapeRegex(status)}$`, "i");
      }

      if (category) {
        query["aiResult.category"] = new RegExp(
          `^${escapeRegex(category)}$`,
          "i",
        );
      }

      if (priority) {
        query["aiResult.states"] = {
          $elemMatch: {
            title: /^priority$/i,
            value: new RegExp(`^${escapeRegex(priority)}$`, "i"),
          },
        };
      }

      const projection = {
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
      };

      const [total, ticketList] = await Promise.all([
        tickets.countDocuments(query),

        tickets
          .find(query, { projection })
          .sort({ updatedAt: -1, createdAt: -1, _id: -1 })
          .skip(skip)
          .limit(limit)
          .toArray(),
      ]);

      // Fetch the agents for this page in one query.
      const agentUids = [
        ...new Set(
          ticketList.flatMap((ticket) =>
            [ticket.currentAgent?.uid, ticket.resolvedBy?.uid].filter(Boolean),
          ),
        ),
      ];

      const agentList = agentUids.length
        ? await users
            .find({ uid: { $in: agentUids } }, { projection: agentProjection })
            .toArray()
        : [];

      const agentMap = new Map(
        agentList.map((agent) => [agent.uid, formatAgent(agent)]),
      );

      const data = ticketList.map((ticket) => ({
        ...ticket,

        currentAgentInfo: agentMap.get(ticket.currentAgent?.uid) || null,

        resolvedByInfo: agentMap.get(ticket.resolvedBy?.uid) || null,

        permission: getPermission(ticket),
      }));

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
    }),
  );

  // =========================================================
  // 3. CUSTOMER DASHBOARD
  // GET /dashboard/customer-overview
  // =========================================================

  router.get(
    "/dashboard/customer-overview",
    ...customerAuth,
    asyncHandler(async (req, res) => {
      const scope = customerScope(req);
      const now = new Date();

      // Use UTC consistently for both MongoDB grouping and JS labels.
      const startDate = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1),
      );

      const nextMonth = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
      );

      const [summaryRows, activityRows, recentTickets] = await Promise.all([
        tickets
          .aggregate([
            { $match: scope },
            {
              $group: {
                _id: null,
                totalTickets: { $sum: 1 },

                openTickets: {
                  $sum: {
                    $cond: [{ $eq: ["$status", "open"] }, 1, 0],
                  },
                },

                assignedTickets: {
                  $sum: {
                    $cond: [{ $eq: ["$status", "assigned"] }, 1, 0],
                  },
                },

                inProgressTickets: {
                  $sum: {
                    $cond: [{ $eq: ["$status", "in_progress"] }, 1, 0],
                  },
                },

                resolvedTickets: {
                  $sum: {
                    $cond: [{ $eq: ["$status", "resolved"] }, 1, 0],
                  },
                },

                closedTickets: {
                  $sum: {
                    $cond: [{ $eq: ["$status", "closed"] }, 1, 0],
                  },
                },

                aiResolved: {
                  $sum: {
                    $cond: [{ $eq: ["$aiResolved", true] }, 1, 0],
                  },
                },
              },
            },
            { $project: { _id: 0 } },
          ])
          .toArray(),

        tickets
          .aggregate([
            {
              $match: {
                ...scope,
                createdAt: {
                  $gte: startDate,
                  $lt: nextMonth,
                },
              },
            },
            {
              $group: {
                _id: {
                  $dateToString: {
                    format: "%Y-%m",
                    date: "$createdAt",
                    timezone: "UTC",
                  },
                },
                count: { $sum: 1 },
              },
            },
            { $sort: { _id: 1 } },
          ])
          .toArray(),

        tickets
          .find(scope, {
            projection: {
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
            },
          })
          .sort({ updatedAt: -1, createdAt: -1, _id: -1 })
          .limit(5)
          .toArray(),
      ]);

      const metrics = summaryRows[0] || {
        totalTickets: 0,
        openTickets: 0,
        assignedTickets: 0,
        inProgressTickets: 0,
        resolvedTickets: 0,
        closedTickets: 0,
        aiResolved: 0,
      };

      // Compatibility with the existing CustomerDashboard card.
      // "Pending" means assigned + in progress; not a new DB status.
      metrics.pendingTickets =
        metrics.assignedTickets + metrics.inProgressTickets;

      const statusChart = {
        open: metrics.openTickets,
        assigned: metrics.assignedTickets,
        in_progress: metrics.inProgressTickets,
        resolved: metrics.resolvedTickets,
        closed: metrics.closedTickets,
      };

      const activityMap = new Map(
        activityRows.map((item) => [item._id, item.count]),
      );

      const activityChart = [];

      for (let i = 11; i >= 0; i--) {
        const date = new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1),
        );

        const key = `${date.getUTCFullYear()}-${String(
          date.getUTCMonth() + 1,
        ).padStart(2, "0")}`;

        activityChart.push({
          month: date.toLocaleDateString("en-US", {
            month: "short",
            timeZone: "UTC",
          }),
          count: activityMap.get(key) || 0,
        });
      }

      const resolutionRate =
        metrics.totalTickets > 0
          ? Math.round(
              ((metrics.resolvedTickets + metrics.closedTickets) /
                metrics.totalTickets) *
                100,
            )
          : 0;

      return res.send({
        success: true,
        metrics,
        statusChart,
        activityChart,
        recentTickets,
        insights: {
          resolutionRate,
          aiResolved: metrics.aiResolved,
        },
      });
    }),
  );

  // =========================================================
  // 4. DELETE TICKET
  // DELETE /tickets/:ticketId
  //
  // Customer can delete only untouched open tickets.
  // Manager/platform deletion is intentionally not handled here.
  // =========================================================

  router.delete(
    "/tickets/:ticketId",
    ...customerAuth,
    loadCustomerTicket,
    asyncHandler(async (req, res) => {
      const ticket = req.customerTicket;

      if (!canDeleteTicket(ticket)) {
        return fail(
          res,
          400,
          "This ticket cannot be deleted because it has support history",
        );
      }

      // Recheck every important condition inside the write query.
      // Prevent deletion if an agent claimed/released the ticket
      // after the initial read.
      const result = await tickets.deleteOne({
        _id: ticket._id,
        ...customerScope(req),
        status: "open",
        aiResolved: { $ne: true },
        "currentAgent.uid": null,
        "resolvedBy.uid": null,

        actionHistory: {
          $not: {
            $elemMatch: {
              $or: [
                { role: "agent" },
                {
                  action: {
                    $in: ["ai_resolved", "reopened", "closed"],
                  },
                },
              ],
            },
          },
        },
      });

      if (result.deletedCount !== 1) {
        return fail(res, 409, "Ticket changed. Please refresh and try again.");
      }

      await notify({
        uid: req.customer.uid,
        userEmail: req.customer.email,
        title: "Ticket Deleted",
        message: `Your ticket ${ticket.ticketNumber} has been deleted.`,
        type: "ticket_deleted",
        ticketNumber: ticket.ticketNumber,
        path: "/customer/tickets",
      });

      return res.send({
        success: true,
        message: "Ticket deleted successfully",
      });
    }),
  );

  // =========================================================
  // 5. CLOSE TICKET
  // PATCH /tickets/:ticketId/close
  // =========================================================

  router.patch(
    "/tickets/:ticketId/close",
    ...customerAuth,
    loadCustomerTicket,
    asyncHandler(async (req, res) => {
      const ticket = req.customerTicket;

      if (ticket.status !== "resolved") {
        return fail(res, 409, "Only resolved tickets can be closed");
      }

      const now = new Date();

      const result = await tickets.updateOne(
        {
          _id: ticket._id,
          ...customerScope(req),
          status: "resolved",
        },
        {
          $set: {
            status: "closed",
            updatedAt: now,
            closedAt: now,
            closedBy: {
              uid: req.customer.uid,
              updatedAt: now,
            },
          },

          $push: {
            actionHistory: {
              uid: req.customer.uid,
              role: "customer",
              action: "closed",
              date: now,
            },
          },
        },
      );

      if (result.modifiedCount !== 1) {
        return fail(
          res,
          409,
          "Ticket status changed. Please refresh and try again.",
        );
      }

      return res.send({
        success: true,
        message: "Ticket closed successfully",
      });
    }),
  );

  // =========================================================
  // 6. REOPEN TICKET
  // PATCH /tickets/:ticketId/reopen
  // =========================================================

  router.patch(
    "/tickets/:ticketId/reopen",
    ...customerAuth,
    loadCustomerTicket,
    asyncHandler(async (req, res) => {
      const ticket = req.customerTicket;

      if (ticket.status !== "resolved") {
        return fail(res, 409, "Only resolved tickets can be reopened");
      }

      const now = new Date();

      const result = await tickets.updateOne(
        {
          _id: ticket._id,
          ...customerScope(req),
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

            // Existing resolvedBy remains as historical information,
            // matching the previous backend behavior.
          },

          $push: {
            actionHistory: {
              uid: req.customer.uid,
              role: "customer",
              action: "reopened",
              date: now,
            },
          },
        },
      );

      if (result.modifiedCount !== 1) {
        return fail(
          res,
          409,
          "Ticket status changed. Please refresh and try again.",
        );
      }

      return res.send({
        success: true,
        message: "Ticket reopened successfully",
      });
    }),
  );

  // =========================================================
  // GET SINGLE TICKET DETAILS (CUSTOMER)
  // GET /tickets/:ticketId
  // =========================================================
  router.get(
    "/tickets/:ticketId",
    ...customerAuth,
    loadCustomerTicket,
    asyncHandler(async (req, res) => {
      const ticket = req.customerTicket;

      const agentUids = [
        ticket.currentAgent?.uid,
        ticket.resolvedBy?.uid,
      ].filter(Boolean);

      const agentList = agentUids.length
        ? await users
            .find({ uid: { $in: agentUids } }, { projection: agentProjection })
            .toArray()
        : [];

      const agentMap = new Map(
        agentList.map((agent) => [agent.uid, formatAgent(agent)]),
      );

      return res.send({
        success: true,
        data: {
          ...ticket,
          currentAgentInfo: agentMap.get(ticket.currentAgent?.uid) || null,
          resolvedByInfo: agentMap.get(ticket.resolvedBy?.uid) || null,
          permission: getPermission(ticket),
        },
      });
    }),
  );

  return router;
};
