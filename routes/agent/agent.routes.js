const express = require("express");
const { ObjectId } = require("mongodb");

module.exports = function createAgentRoutes({
  users,
  companies,
  tickets,
  supportConversations,
  verifyFirebaseToken,
  createNotification,
  suggestAgentReply,
}) {
  const router = express.Router();

  // =====================================================
  // HELPERS
  // =====================================================

  const fail = (res, status, message) => {
    return res.status(status).send({
      success: false,
      message,
    });
  };

  const handle = (callback) => {
    return async (req, res, next) => {
      try {
        await callback(req, res, next);
      } catch (error) {
        console.error(
          `Agent API error: ${req.method} ${req.originalUrl}`,
          error,
        );

        if (res.headersSent) return next(error);

        return fail(res, 500, "Something went wrong. Please try again.");
      }
    };
  };

  const text = (value, max = 200) => {
    return typeof value === "string" ? value.trim().slice(0, max) : "";
  };

  const escapeRegex = (value) => {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  };

  const integer = (value, fallback, maximum) => {
    const number = typeof value === "string" ? Number(value) : NaN;

    return Number.isSafeInteger(number) && number > 0
      ? Math.min(number, maximum)
      : fallback;
  };

  const notify = async (data) => {
    try {
      await createNotification(data);
    } catch (error) {
      console.error("Agent notification error:", error.message);
    }
  };

  const personProjection = {
    _id: 0,
    uid: 1,
    displayName: 1,
    name: 1,
    email: 1,
    photoURL: 1,
    role: 1,
    status: 1,
  };

  const formatPerson = (person, defaultRole) => {
    if (!person?.uid) return null;

    return {
      uid: person.uid,
      displayName: person.displayName || person.name || null,
      email: person.email || null,
      photoURL: person.photoURL || null,
      role: person.role || defaultRole,
      status: person.status || null,
    };
  };

  const ticketProjection = {
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
    currentAgent: 1,
    resolvedBy: 1,
    "aiResult.ticketTitle": 1,
    "aiResult.summary": 1,
    "aiResult.category": 1,
    "aiResult.states": 1,
  };

  const activeStatuses = ["assigned", "in_progress"];

  // Preserve the existing default My Tickets behavior:
  // assigned + in_progress + resolved.
  const myTicketFilter = (req) => ({
    companyId: req.agentCompanyId,
    "currentAgent.uid": req.agent.uid,
    aiResolved: false,
    status: { $in: [...activeStatuses, "resolved"] },
  });

  const queueFilter = (req) => ({
    companyId: req.agentCompanyId,
    status: "open",
    aiResolved: false,
    "currentAgent.uid": null,
  });

  const permissionFor = (ticket, agentUid) => {
    const isCurrentAgent = ticket.currentAgent?.uid === agentUid;

    const human = ticket.aiResolved !== true;

    const canAssign =
      human && ticket.status === "open" && !ticket.currentAgent?.uid;

    const canWork =
      human && isCurrentAgent && activeStatuses.includes(ticket.status);

    const canReadMessages =
      human &&
      isCurrentAgent &&
      [...activeStatuses, "resolved", "closed"].includes(ticket.status);

    return {
      canRead: ticket.aiResolved === true || canAssign || canReadMessages,

      canReadMessages,
      canSendMessage: canWork,
      canSuggestReply: canWork,
      canRelease: canWork,
      canResolve: canWork,
      canAssign,
      canClose: false,
      canReopen: false,
      isCurrentAgent,
    };
  };

  // Used for lists and urgent-ticket customer information.
  const personLookup = (field, output) => [
    {
      $lookup: {
        from: "users",
        localField: field,
        foreignField: "uid",
        pipeline: [{ $project: personProjection }],
        as: output,
      },
    },
    {
      $set: {
        [output]: { $arrayElemAt: [`$${output}`, 0] },
      },
    },
  ];

  // =====================================================
  // AUTHORIZATION
  // Applied per route, not globally to the router.
  // =====================================================

  const verifyAgent = handle(async (req, res, next) => {
    const agent = await users.findOne({
      uid: req.user.uid,
    });

    if (!agent) {
      return fail(res, 404, "User not found");
    }

    if (agent.role !== "agent") {
      return fail(res, 403, "Support agent access required");
    }

    if (agent.status !== "active") {
      return fail(res, 403, "Your account is not active");
    }

    if (agent.verifyIdAgent !== "approved") {
      return fail(res, 403, "Your agent account requires manager approval");
    }

    if (!agent.companyId || !ObjectId.isValid(agent.companyId)) {
      return fail(res, 403, "Your company information is invalid");
    }

    const companyId = new ObjectId(agent.companyId);

    const company = await companies.findOne(
      { _id: companyId },
      {
        projection: {
          _id: 1,
          companyName: 1,
          status: 1,
        },
      },
    );

    if (!company || company.status !== "active") {
      return fail(res, 403, "Your company is not active");
    }

    req.agent = agent;
    req.agentCompanyId = companyId;
    req.agentCompany = company;

    next();
  });

  const agentAuth = [verifyFirebaseToken, verifyAgent];

  // =====================================================
  // AGENT DASHBOARD
  // GET /dashboard/agent-overview
  // =====================================================

  // =====================================================
  // AGENT DASHBOARD
  // GET /dashboard/agent-overview
  // =====================================================

  router.get(
    "/dashboard/agent-overview",
    ...agentAuth,
    handle(async (req, res) => {
      const companyId = req.agentCompanyId;
      const agentUid = req.agent.uid;

      // Display the latest 5 actual company tickets.
      const recentLimit = 5;
      const urgentLimit = 6;

      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const todayEnd = new Date(todayStart);
      todayEnd.setDate(todayEnd.getDate() + 1);

      // Open, unassigned human tickets.
      const queueMatch = {
        aiResolved: { $ne: true },
        status: "open",
        "currentAgent.uid": { $in: [null, ""] },
      };

      // Tickets currently being handled by this agent.
      const myActiveMatch = {
        aiResolved: { $ne: true },
        "currentAgent.uid": agentUid,
        status: { $in: ["assigned", "in_progress"] },
      };

      const actionableMatch = {
        $or: [queueMatch, myActiveMatch],
      };

      const urgentMatch = {
        ...queueMatch,
        dashboardPriority: { $in: ["high", "critical"] },
      };

      const dashboardProjection = {
        _id: 1,
        uid: 1,
        ticketNumber: 1,
        status: 1,
        supportMode: 1,
        aiResolved: 1,
        currentAgent: 1,
        createdAt: 1,
        updatedAt: 1,

        "aiResult.ticketTitle": 1,
        "aiResult.summary": 1,
        "aiResult.category": 1,
        "aiResult.states": 1,

        priority: "$dashboardPriority",
      };

      const [result] = await tickets
        .aggregate([
          // Only tickets from the agent's company.
          {
            $match: {
              companyId,
            },
          },

          // Extract Priority from AI analysis.
          {
            $set: {
              dashboardPriorityState: {
                $arrayElemAt: [
                  {
                    $filter: {
                      input: {
                        $cond: [
                          { $isArray: "$aiResult.states" },
                          "$aiResult.states",
                          [],
                        ],
                      },
                      as: "state",
                      cond: {
                        $eq: [
                          {
                            $toLower: {
                              $trim: {
                                input: {
                                  $convert: {
                                    input: "$$state.title",
                                    to: "string",
                                    onError: "",
                                    onNull: "",
                                  },
                                },
                              },
                            },
                          },
                          "priority",
                        ],
                      },
                    },
                  },
                  0,
                ],
              },
            },
          },

          // Normalize priority and update timestamp.
          {
            $set: {
              dashboardPriority: {
                $toLower: {
                  $trim: {
                    input: {
                      $convert: {
                        input: {
                          $ifNull: [
                            "$dashboardPriorityState.value",
                            {
                              $ifNull: ["$aiResult.priority", "$priority"],
                            },
                          ],
                        },
                        to: "string",
                        onError: "",
                        onNull: "",
                      },
                    },
                  },
                },
              },

              dashboardUpdatedAt: {
                $ifNull: ["$updatedAt", "$createdAt"],
              },
            },
          },

          {
            $facet: {
              // My currently active tickets.
              assignedToMe: [{ $match: myActiveMatch }, { $count: "count" }],

              // Unassigned company queue.
              openCompanyTickets: [{ $match: queueMatch }, { $count: "count" }],

              // My tickets currently in progress.
              inProgressTickets: [
                {
                  $match: {
                    ...myActiveMatch,
                    status: "in_progress",
                  },
                },
                { $count: "count" },
              ],

              // Resolved by me today.
              resolvedToday: [
                {
                  $match: {
                    "resolvedBy.uid": agentUid,
                    status: { $in: ["resolved", "closed"] },
                    resolvedAt: {
                      $gte: todayStart,
                      $lt: todayEnd,
                    },
                  },
                },
                { $count: "count" },
              ],

              // Company-wide status chart.
              statusRows: [
                {
                  $group: {
                    _id: "$status",
                    count: { $sum: 1 },
                  },
                },
              ],

              // Actionable priority chart.
              priorityRows: [
                { $match: actionableMatch },
                {
                  $group: {
                    _id: "$dashboardPriority",
                    count: { $sum: 1 },
                  },
                },
              ],

              // Count all company tickets.
              recentTotal: [{ $count: "count" }],

              // Latest 5 company tickets.
              // Includes all statuses and AI-resolved tickets.
              recentTickets: [
                {
                  $sort: {
                    dashboardUpdatedAt: -1,
                    createdAt: -1,
                    _id: -1,
                  },
                },
                {
                  $limit: recentLimit,
                },
                {
                  $project: dashboardProjection,
                },
              ],

              // Count unassigned high/critical tickets.
              urgentTotal: [{ $match: urgentMatch }, { $count: "count" }],

              // Urgent tickets, critical first.
              urgentTickets: [
                { $match: urgentMatch },

                {
                  $set: {
                    dashboardPriorityScore: {
                      $cond: [
                        {
                          $eq: ["$dashboardPriority", "critical"],
                        },
                        2,
                        1,
                      ],
                    },
                  },
                },

                {
                  $sort: {
                    dashboardPriorityScore: -1,
                    createdAt: 1,
                    _id: 1,
                  },
                },

                {
                  $limit: urgentLimit,
                },

                {
                  $project: dashboardProjection,
                },
              ],
            },
          },
        ])
        .toArray();

      const overview = result || {};

      // ========================================
      // STATUS CHART
      // ========================================

      const statusChart = {
        open: 0,
        assigned: 0,
        in_progress: 0,
        resolved: 0,
        closed: 0,
      };

      for (const row of overview.statusRows || []) {
        if (Object.hasOwn(statusChart, row._id)) {
          statusChart[row._id] = row.count;
        }
      }

      // ========================================
      // PRIORITY CHART
      // ========================================

      const priorityChart = {
        low: 0,
        medium: 0,
        high: 0,
        critical: 0,
      };

      for (const row of overview.priorityRows || []) {
        if (Object.hasOwn(priorityChart, row._id)) {
          priorityChart[row._id] = row.count;
        }
      }

      // ========================================
      // CUSTOMER INFORMATION FOR URGENT TICKETS
      // ========================================

      const urgentRows = overview.urgentTickets || [];

      const customerUids = [
        ...new Set(
          urgentRows
            .map((ticket) => ticket.uid)
            .filter((uid) => typeof uid === "string" && uid),
        ),
      ];

      const customers = customerUids.length
        ? await users
            .find(
              {
                uid: { $in: customerUids },
              },
              {
                projection: personProjection,
              },
            )
            .toArray()
        : [];

      const customerMap = new Map(
        customers.map((customer) => [customer.uid, customer]),
      );

      // ========================================
      // RECENT TICKETS
      // ========================================

      const recentTickets = (overview.recentTickets || []).map((ticket) => ({
        ...ticket,
        permission: permissionFor(ticket, agentUid),
      }));

      // ========================================
      // URGENT TICKETS
      // ========================================

      const urgentTickets = urgentRows.map((ticket) => {
        const userInfo = formatPerson(customerMap.get(ticket.uid), "customer");

        return {
          ...ticket,
          userInfo,
          email: userInfo?.email || null,
          customerName: userInfo?.displayName || null,
          permission: permissionFor(ticket, agentUid),
        };
      });

      // ========================================
      // RESPONSE
      // ========================================

      return res.send({
        success: true,

        metrics: {
          assignedToMe: overview.assignedToMe?.[0]?.count || 0,

          openCompanyTickets: overview.openCompanyTickets?.[0]?.count || 0,

          inProgressTickets: overview.inProgressTickets?.[0]?.count || 0,

          resolvedToday: overview.resolvedToday?.[0]?.count || 0,

          urgentActionableTickets: priorityChart.high + priorityChart.critical,

          unassignedUrgentTickets: overview.urgentTotal?.[0]?.count || 0,
        },

        statusChart,
        priorityChart,

        recentTickets,
        urgentTickets,

        recentTotal: overview.recentTotal?.[0]?.count || 0,

        urgentTotal: overview.urgentTotal?.[0]?.count || 0,

        recentLimit,
        urgentLimit,
      });
    }),
  );

  // =====================================================
  // 2 & 3. COMPANY / ASSIGNED TICKET LISTS
  // =====================================================

  const listTickets = (onlyMine) =>
    handle(async (req, res) => {
      const search = text(req.query.search);
      const status = text(req.query.status, 40);
      const priority = text(req.query.priority, 40);
      const category = text(req.query.category, 80);

      const page = integer(req.query.page, 1, 1000000);
      const limit = integer(req.query.limit, 10, 100);

      const match = onlyMine
        ? myTicketFilter(req)
        : { companyId: req.agentCompanyId };

      // Preserve existing explicit status-filter behavior.
      // Agent ownership remains enforced for My Tickets.
      if (status) {
        match.status = new RegExp(`^${escapeRegex(status)}$`, "i");
      }

      if (category) {
        match["aiResult.category"] = new RegExp(
          `^${escapeRegex(category)}$`,
          "i",
        );
      }

      if (priority) {
        match["aiResult.states"] = {
          $elemMatch: {
            title: /^priority$/i,
            value: new RegExp(`^${escapeRegex(priority)}$`, "i"),
          },
        };
      }

      const pipeline = [{ $match: match }, ...personLookup("uid", "userInfo")];

      if (search) {
        const regex = new RegExp(escapeRegex(search), "i");

        pipeline.push({
          $match: {
            $or: [
              { ticketNumber: regex },
              { "aiResult.ticketTitle": regex },
              { "aiResult.summary": regex },
              { "userInfo.email": regex },
              { "userInfo.displayName": regex },
            ],
          },
        });
      }

      const [countRows, rows] = await Promise.all([
        tickets.aggregate([...pipeline, { $count: "total" }]).toArray(),

        tickets
          .aggregate([
            ...pipeline,
            {
              $sort: onlyMine
                ? { updatedAt: -1, _id: -1 }
                : { createdAt: -1, _id: -1 },
            },
            { $skip: (page - 1) * limit },
            { $limit: limit },
            ...personLookup("currentAgent.uid", "agentInfo"),
            ...personLookup("resolvedBy.uid", "resolvedByInfo"),
            {
              $project: {
                ...ticketProjection,
                userInfo: 1,
                agentInfo: 1,
                resolvedByInfo: 1,
              },
            },
          ])
          .toArray(),
      ]);

      const total = countRows[0]?.total || 0;

      const data = rows.map((ticket) => ({
        ...ticket,
        userInfo: formatPerson(ticket.userInfo, "customer"),
        agentInfo: formatPerson(ticket.agentInfo, "agent"),
        resolvedByInfo: formatPerson(ticket.resolvedByInfo, "agent"),
        permission: permissionFor(ticket, req.agent.uid),
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
    });

  router.get("/agent/company-tickets", ...agentAuth, listTickets(false));

  router.get("/agent/assigned-tickets", ...agentAuth, listTickets(true));

  // =====================================================
  // 4, 5 & 6. ASSIGN / RELEASE / RESOLVE
  // Each write checks company, status and assignment.
  // =====================================================

  const changeTicket = (action) =>
    handle(async (req, res) => {
      if (!ObjectId.isValid(req.params.id)) {
        return fail(res, 400, "Invalid ticket ID");
      }

      const scope = {
        _id: new ObjectId(req.params.id),
        companyId: req.agentCompanyId,
      };

      const ticket = await tickets.findOne(scope);

      if (!ticket) {
        return fail(res, 404, "Ticket not found");
      }

      if (ticket.aiResolved === true) {
        return fail(
          res,
          409,
          "This action is unavailable for AI-resolved tickets",
        );
      }

      if (action === "assign") {
        if (ticket.status !== "open" || ticket.currentAgent?.uid) {
          return fail(
            res,
            409,
            "This ticket is no longer available for assignment",
          );
        }
      } else {
        if (ticket.currentAgent?.uid !== req.agent.uid) {
          return fail(
            res,
            403,
            "Only the current agent can perform this action",
          );
        }

        if (!activeStatuses.includes(ticket.status)) {
          return fail(
            res,
            409,
            "This action is unavailable in the current ticket status",
          );
        }
      }

      const now = new Date();

      const filter = {
        ...scope,
        aiResolved: false,
        ...(action === "assign"
          ? {
              status: "open",
              "currentAgent.uid": null,
            }
          : {
              status: { $in: activeStatuses },
              "currentAgent.uid": req.agent.uid,
            }),
      };

      const changes = {
        supportMode: "human",
        aiResolved: false,
        escalatedToHuman: true,
        updatedAt: now,
      };

      let historyAction;
      let message;

      if (action === "assign") {
        Object.assign(changes, {
          status: "assigned",
          resolutionSource: null,
          currentAgent: {
            uid: req.agent.uid,
            updatedAt: now,
          },
        });

        historyAction = "assigned";
        message = "Ticket assigned successfully";
      } else if (action === "release") {
        Object.assign(changes, {
          status: "open",
          resolutionSource: null,
          currentAgent: null,
        });

        historyAction = "released";
        message = "Ticket returned to company queue successfully";
      } else {
        Object.assign(changes, {
          status: "resolved",
          resolutionSource: "agent",
          resolvedAt: now,
          currentAgent: {
            uid: req.agent.uid,
            updatedAt: now,
          },
          resolvedBy: {
            uid: req.agent.uid,
            updatedAt: now,
          },
        });

        historyAction = "resolved";
        message = "Ticket resolved successfully";
      }

      // MongoDB driver v7 returns the document directly
      // with includeResultMetadata: false.
      const updatedTicket = await tickets.findOneAndUpdate(
        filter,
        {
          $set: changes,
          $push: {
            actionHistory: {
              uid: req.agent.uid,
              role: "agent",
              action: historyAction,
              date: now,
            },
          },
        },
        {
          returnDocument: "after",
          includeResultMetadata: false,
        },
      );

      if (!updatedTicket) {
        return fail(res, 409, "Ticket changed. Please refresh and try again.");
      }

      const customerCopy = {
        assign: {
          title: "Ticket Assigned to Support Agent",
          message: `Your ticket ${ticket.ticketNumber} has been assigned to a support agent.`,
          type: "ticket_assigned",
        },
        release: {
          title: "Ticket Returned to Support Queue",
          message: `Your ticket ${ticket.ticketNumber} has been returned to the support queue.`,
          type: "ticket_released",
        },
        resolve: {
          title: "Ticket Resolved",
          message: `Your ticket ${ticket.ticketNumber} has been resolved by our support team.`,
          type: "ticket_resolved",
        },
      };

      const agentCopy = {
        assign: {
          title: "Ticket Assigned to You",
          message: `Ticket ${ticket.ticketNumber} has been assigned to you.`,
          type: "ticket_assigned",
        },
        release: {
          title: "Ticket Returned to Queue",
          message: `You returned ticket ${ticket.ticketNumber} to the company queue.`,
          type: "ticket_returned",
        },
        resolve: {
          title: "Ticket Resolved",
          message: `You resolved ticket ${ticket.ticketNumber}.`,
          type: "ticket_resolved",
        },
      };

      await Promise.all([
        notify({
          uid: ticket.uid,
          ...customerCopy[action],
          ticketId: ticket._id,
          ticketNumber: ticket.ticketNumber,
          path: `/customer/tickets/${ticket._id}`,
        }),

        notify({
          uid: req.agent.uid,
          userEmail: req.agent.email,
          ...agentCopy[action],
          ticketId: ticket._id,
          ticketNumber: ticket.ticketNumber,
          path: `/agent/tickets/${ticket._id}`,
        }),
      ]);

      return res.send({
        success: true,
        message,
        data: updatedTicket,
      });
    });

  router.patch(
    "/agent/tickets/:id/assign",
    ...agentAuth,
    changeTicket("assign"),
  );

  router.patch(
    "/agent/tickets/:id/release",
    ...agentAuth,
    changeTicket("release"),
  );

  router.patch(
    "/agent/tickets/:id/resolve",
    ...agentAuth,
    changeTicket("resolve"),
  );

  // =====================================================
  // 7. AI REPLY SUGGESTION
  // POST /ai/suggest-reply
  // =====================================================

  router.post(
    "/ai/suggest-reply",
    ...agentAuth,
    handle(async (req, res) => {
      const { ticketId, agentDraft = "" } = req.body || {};

      if (typeof ticketId !== "string" || !ObjectId.isValid(ticketId)) {
        return fail(res, 400, "Valid ticketId is required");
      }

      if (typeof agentDraft !== "string" || agentDraft.length > 10000) {
        return fail(
          res,
          400,
          "Agent draft must be text with at most 10000 characters",
        );
      }

      const scope = {
        _id: new ObjectId(ticketId),
        companyId: req.agentCompanyId,
      };

      const ticket = await tickets.findOne(scope);

      if (!ticket) {
        return fail(res, 404, "Ticket not found");
      }

      if (ticket.currentAgent?.uid !== req.agent.uid) {
        return fail(res, 403, "Only the current agent can generate a reply");
      }

      if (
        ticket.aiResolved === true ||
        !activeStatuses.includes(ticket.status)
      ) {
        return fail(
          res,
          409,
          "AI suggested reply is unavailable for this ticket",
        );
      }

      const customer = await users.findOne(
        { uid: ticket.uid },
        { projection: personProjection },
      );

      if (!customer) {
        return fail(res, 404, "Customer not found");
      }

      const history = await supportConversations
        .find(
          { ticketId: ticket._id },
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
        .sort({ createdAt: -1, _id: -1 })
        .limit(15)
        .toArray();

      history.reverse();

      const analysis = ticket.aiResult || {};

      const result = await suggestAgentReply({
        ticketContext: {
          ticketNumber: ticket.ticketNumber || null,
          status: ticket.status,
          supportMode: ticket.supportMode || null,
          resolutionSource: ticket.resolutionSource || null,
          description: ticket.ticketData?.description || null,

          aiAnalysis: {
            ticketTitle: analysis.ticketTitle || null,
            summary: analysis.summary || null,
            category: analysis.category || null,
            rootCause: analysis.rootCause || null,
            metrics: analysis.metrics || [],
            states: analysis.states || [],
            recommendations: analysis.recommendations || [],
            steps: analysis.steps || [],
            escalation: analysis.escalation || null,
          },
        },

        customerContext: {
          uid: customer.uid,
          displayName: customer.displayName || customer.name || "Customer",
          email: customer.email || null,
          role: customer.role || "customer",
          companyName: req.agentCompany.companyName || null,
        },

        agentContext: {
          uid: req.agent.uid,
          displayName:
            req.agent.displayName || req.agent.name || "Support Agent",
          email: req.agent.email || null,
          role: "agent",
        },

        conversationHistory: history,
        agentDraft: agentDraft.trim(),
      });

      // AI generation can take time. Recheck access and ticket state
      // before returning the suggestion.
      const [stillAssigned, activeAgent, activeCompany] = await Promise.all([
        tickets.findOne(
          {
            ...scope,
            "currentAgent.uid": req.agent.uid,
            status: { $in: activeStatuses },
            aiResolved: false,
          },
          { projection: { _id: 1 } },
        ),

        users.findOne(
          {
            uid: req.agent.uid,
            role: "agent",
            status: "active",
            verifyIdAgent: "approved",
            companyId: req.agent.companyId,
          },
          { projection: { _id: 1 } },
        ),

        companies.findOne(
          {
            _id: req.agentCompanyId,
            status: "active",
          },
          { projection: { _id: 1 } },
        ),
      ]);

      if (!activeAgent || !activeCompany) {
        return fail(res, 403, "Your access has changed");
      }

      if (!stillAssigned) {
        return fail(
          res,
          409,
          "Ticket changed while generating the reply. Please refresh.",
        );
      }

      return res.send({
        success: true,
        data: {
          reply: result.reply,
        },
        meta: result.meta,
      });
    }),
  );

  // =====================================================
  // AGENT TICKET DETAILS
  // GET /agent/tickets/:id
  // =====================================================

  router.get(
    "/agent/tickets/:id",
    ...agentAuth,
    handle(async (req, res) => {
      const ticketId = req.params.id;

      if (typeof ticketId !== "string" || !/^[a-f\d]{24}$/i.test(ticketId)) {
        return fail(res, 400, "Invalid ticket ID");
      }

      // Only tickets belonging to the agent's company.
      const ticket = await tickets.findOne(
        {
          _id: new ObjectId(ticketId),
          companyId: req.agentCompanyId,
        },
        {
          projection: {
            _id: 1,
            uid: 1,
            companyId: 1,
            ticketNumber: 1,

            ticketData: 1,
            subject: 1,
            description: 1,
            category: 1,
            aiResult: 1,

            status: 1,
            supportMode: 1,
            resolutionSource: 1,
            aiResolved: 1,
            escalatedToHuman: 1,

            currentAgent: 1,
            resolvedBy: 1,
            closedBy: 1,

            resolvedAt: 1,
            reopenedAt: 1,
            closedAt: 1,
            createdAt: 1,
            updatedAt: 1,

            actionHistory: 1,
          },
        },
      );

      if (!ticket) {
        return fail(res, 404, "Ticket not found");
      }

      // Enforce access before returning ticket/customer data.
      const permission = permissionFor(ticket, req.agent.uid);

      if (!permission.canRead) {
        return fail(res, 403, "You cannot view this ticket");
      }

      const personUids = [
        ...new Set(
          [ticket.uid, ticket.currentAgent?.uid, ticket.resolvedBy?.uid].filter(
            (uid) => typeof uid === "string" && uid.trim(),
          ),
        ),
      ];

      const people = personUids.length
        ? await users
            .find(
              {
                uid: { $in: personUids },
              },
              {
                projection: personProjection,
              },
            )
            .toArray()
        : [];

      const personMap = new Map(people.map((person) => [person.uid, person]));

      return res.send({
        success: true,

        data: {
          ...ticket,

          userInfo: formatPerson(personMap.get(ticket.uid), "customer"),

          agentInfo: formatPerson(
            personMap.get(ticket.currentAgent?.uid),
            "agent",
          ),

          resolvedByInfo: formatPerson(
            personMap.get(ticket.resolvedBy?.uid),
            "agent",
          ),

          permission,
        },
      });
    }),
  );

  return router;
};
