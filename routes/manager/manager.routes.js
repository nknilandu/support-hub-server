const express = require("express");
const { ObjectId } = require("mongodb");

module.exports = function createManagerRoutes({
  client,
  users,
  companies,
  tickets,
  notifications,
  verifyFirebaseToken,
  createNotification,
}) {
  const router = express.Router();

  const PAGE_SIZE = 5;
  const ACTIVE_STATUSES = ["assigned", "in_progress"];
  const COMPLETED_STATUSES = ["resolved", "closed"];
  const DAY_MS = 86400000;
  const DHAKA_OFFSET = 6 * 60 * 60 * 1000;

  // =====================================================
  // HELPERS
  // =====================================================

  const handle = (callback) => async (req, res, next) => {
    try {
      await callback(req, res, next);
    } catch (error) {
      next(error);
    }
  };

  const fail = (status, message) => {
    throw Object.assign(new Error(message), { status });
  };

  const companyScope = (companyId) => ({
    companyId: {
      $in: [companyId, companyId.toHexString()],
    },
  });

  const queryText = (value, name, maxLength = 100) => {
    if (value == null) return "";

    if (typeof value !== "string") {
      fail(400, `${name} must be a string`);
    }

    const result = value.trim();

    if (result.length > maxLength) {
      fail(400, `${name} is too long`);
    }

    return result;
  };

  const getPage = (value, name = "page") => {
    if (value == null || value === "") return 1;

    if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
      fail(400, `${name} must be a positive integer`);
    }

    const page = Number(value);

    if (!Number.isSafeInteger(page) || page > 100000) {
      fail(400, `Invalid ${name}`);
    }

    return page;
  };

  const validateUid = (uid) => {
    if (
      typeof uid !== "string" ||
      !uid.trim() ||
      uid.length > 128 ||
      /[\u0000-\u001f\u007f]/.test(uid)
    ) {
      fail(400, "Invalid agent uid");
    }

    return uid;
  };

  const timeOf = (value) => {
    if (!value) return 0;

    const time = new Date(value).getTime();
    return Number.isFinite(time) ? time : 0;
  };

  const dayKey = (value) => {
    if (!value) return null;

    const time = new Date(value).getTime();
    if (!Number.isFinite(time)) return null;

    return new Date(time + DHAKA_OFFSET).toISOString().slice(0, 10);
  };

  const paginate = (items, requestedPage) => {
    const total = items.length;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const page = Math.min(requestedPage, totalPages);
    const start = (page - 1) * PAGE_SIZE;

    return {
      rows: items.slice(start, start + PAGE_SIZE),
      pagination: {
        page,
        limit: PAGE_SIZE,
        total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1,
      },
    };
  };

  const getPriority = (ticket) => {
    const states = Array.isArray(ticket.aiResult?.states)
      ? ticket.aiResult.states
      : [];

    const priorityState = states.find(
      (state) =>
        typeof state?.title === "string" &&
        state.title.trim().toLowerCase() === "priority",
    );

    const value =
      priorityState?.value ?? ticket.aiResult?.priority ?? ticket.priority;

    return typeof value === "string" ? value.trim().toLowerCase() : null;
  };

  const getResolutionSource = (ticket) => {
    if (["ai", "agent"].includes(ticket.resolutionSource)) {
      return ticket.resolutionSource;
    }

    if (ticket.aiResolved === true) return "ai";
    if (ticket.resolvedBy?.uid) return "agent";

    return "unknown";
  };

  const personProjection = {
    _id: 1,
    uid: 1,
    displayName: 1,
    email: 1,
    photoURL: 1,
    role: 1,
    status: 1,
    verifyIdAgent: 1,
    companyId: 1,
    companyName: 1,
    createdAt: 1,
    updatedAt: 1,
    rejectionReason: 1,
    approvedReason: 1,
    approvedBy: 1,
    approvedAt: 1,
  };

  const ticketProjection = {
    _id: 1,
    uid: 1,
    ticketNumber: 1,
    status: 1,
    supportMode: 1,
    aiResolved: 1,
    resolutionSource: 1,
    currentAgent: 1,
    resolvedBy: 1,
    createdAt: 1,
    updatedAt: 1,
    resolvedAt: 1,
    priority: 1,
    "aiResult.ticketTitle": 1,
    "aiResult.summary": 1,
    "aiResult.category": 1,
    "aiResult.priority": 1,
    "aiResult.states": 1,
  };

  const companyInfo = (company) => ({
    _id: company._id,
    companyName: company.companyName || null,
    companyLogo: company.companyLogo || null,
    status: company.status,
  });

  const getSeats = (approvedCount) => ({
    used: approvedCount,
    limit: null,
    remainingSeats: null,
    configured: false,
    limitReached: false,
    enforced: false,
  });

  const permissions = (agent) => ({
    canApprove: ["pending", "rejected"].includes(agent.verifyIdAgent),
    canReject: agent.verifyIdAgent === "pending",
    canSuspend: agent.verifyIdAgent === "approved" && agent.status === "active",
    canActivate:
      agent.verifyIdAgent === "approved" && agent.status === "suspended",
  });

  // =====================================================
  // MANAGER / OWNER AUTHORIZATION
  // =====================================================

  const verifyManager = handle(async (req, res, next) => {
    if (!req.user?.uid) {
      fail(401, "Authentication required");
    }

    const manager = await users.findOne(
      { uid: req.user.uid },
      { projection: personProjection },
    );

    if (!manager) {
      fail(404, "User account not found");
    }

    if (!["manager", "owner"].includes(manager.role)) {
      fail(403, "Manager or owner access required");
    }

    if (manager.status !== "active") {
      fail(403, "Your account is not active");
    }

    if (!manager.companyId || !ObjectId.isValid(manager.companyId)) {
      fail(403, "Your account is not linked to a company");
    }

    const companyId = new ObjectId(manager.companyId);

    const company = await companies.findOne(
      { _id: companyId },
      {
        projection: {
          _id: 1,
          companyName: 1,
          companyLogo: 1,
          status: 1,
        },
      },
    );

    if (!company || company.status !== "active") {
      fail(403, "Your company is unavailable or inactive");
    }

    req.manager = manager;
    req.managerCompany = company;
    req.managerCompanyId = companyId;
    req.managerScope = companyScope(companyId);

    res.set("Cache-Control", "no-store");
    next();
  });

  const protectedRoute = [verifyFirebaseToken, verifyManager];

  // =====================================================
  // COMPANY DATA LOADERS
  // =====================================================

  const loadCompanyData = async (scope) => {
    const [agents, companyTickets] = await Promise.all([
      users
        .find({ ...scope, role: "agent" }, { projection: personProjection })
        .toArray(),

      tickets.find(scope, { projection: ticketProjection }).toArray(),
    ]);

    return { agents, companyTickets };
  };

  const buildAgentMetrics = (agents, companyTickets) => {
    const metricMap = new Map();

    for (const ticket of companyTickets) {
      if (ACTIVE_STATUSES.includes(ticket.status) && ticket.currentAgent?.uid) {
        const uid = ticket.currentAgent.uid;

        const metric = metricMap.get(uid) || {
          activeCount: 0,
          solvedCount: 0,
        };

        metric.activeCount += 1;
        metricMap.set(uid, metric);
      }

      if (
        COMPLETED_STATUSES.includes(ticket.status) &&
        ticket.resolvedBy?.uid
      ) {
        const uid = ticket.resolvedBy.uid;

        const metric = metricMap.get(uid) || {
          activeCount: 0,
          solvedCount: 0,
        };

        metric.solvedCount += 1;
        metricMap.set(uid, metric);
      }
    }

    return agents.map((agent) => ({
      ...agent,
      activeCount: metricMap.get(agent.uid)?.activeCount || 0,
      solvedCount: metricMap.get(agent.uid)?.solvedCount || 0,
      permission: permissions(agent),
    }));
  };

  // =====================================================
  // GET /dashboard/manager-overview
  // =====================================================

  router.get(
    "/dashboard/manager-overview",
    ...protectedRoute,
    handle(async (req, res) => {
      const scope = req.managerScope;

      const [
        { agents, companyTickets },
        customerTotal,
        activeCustomerTotal,
        recentNotifications,
      ] = await Promise.all([
        loadCompanyData(scope),

        users.countDocuments({
          ...scope,
          role: "customer",
        }),

        users.countDocuments({
          ...scope,
          role: "customer",
          status: "active",
        }),

        notifications
          .find(
            {
              ...scope,
              uid: req.manager.uid,
            },
            {
              projection: {
                _id: 1,
                type: 1,
                title: 1,
                message: 1,
                path: 1,
                isRead: 1,
                createdAt: 1,
              },
            },
          )
          .sort({ createdAt: -1, _id: -1 })
          .limit(PAGE_SIZE)
          .toArray(),
      ]);

      const statusChart = {
        open: 0,
        assigned: 0,
        in_progress: 0,
        resolved: 0,
        closed: 0,
        unknown: 0,
      };

      const resolutionChart = {
        ai: 0,
        agent: 0,
        unknown: 0,
      };

      const now = new Date();
      const today = new Date(`${dayKey(now)}T00:00:00+06:00`);

      const activityChart = Array.from({ length: 7 }, (_, index) => {
        const date = new Date(today.getTime() - (6 - index) * DAY_MS);

        return {
          day: dayKey(date),
          date: date.toLocaleDateString("en-GB", {
            timeZone: "Asia/Dhaka",
            day: "2-digit",
            month: "short",
          }),
          created: 0,
          resolved: 0,
        };
      });

      const activityMap = new Map(
        activityChart.map((item) => [item.day, item]),
      );

      const urgentTickets = [];
      let unassignedTickets = 0;
      let activeHumanTickets = 0;

      for (const ticket of companyTickets) {
        const statusKey = Object.prototype.hasOwnProperty.call(
          statusChart,
          ticket.status,
        )
          ? ticket.status
          : "unknown";

        statusChart[statusKey] += 1;

        const createdDay = activityMap.get(dayKey(ticket.createdAt));
        if (createdDay) createdDay.created += 1;

        if (COMPLETED_STATUSES.includes(ticket.status)) {
          resolutionChart[getResolutionSource(ticket)] += 1;

          const resolvedDay = activityMap.get(dayKey(ticket.resolvedAt));

          if (resolvedDay) resolvedDay.resolved += 1;
        }

        const isHuman = ticket.supportMode !== "ai";

        if (isHuman && ticket.status === "open" && !ticket.currentAgent?.uid) {
          unassignedTickets += 1;
        }

        if (isHuman && ACTIVE_STATUSES.includes(ticket.status)) {
          activeHumanTickets += 1;
        }

        const priority = getPriority(ticket);

        if (
          isHuman &&
          ["open", "in_progress"].includes(ticket.status) &&
          ["high", "critical"].includes(priority)
        ) {
          urgentTickets.push({
            ...ticket,
            priority,
          });
        }
      }

      urgentTickets.sort((a, b) => {
        const priorityDifference =
          (a.priority === "critical" ? 0 : 1) -
          (b.priority === "critical" ? 0 : 1);

        if (priorityDifference) return priorityDifference;

        const assignmentDifference =
          (a.currentAgent?.uid ? 1 : 0) - (b.currentAgent?.uid ? 1 : 0);

        if (assignmentDifference) return assignmentDifference;

        return (
          timeOf(a.createdAt) - timeOf(b.createdAt) ||
          String(a._id).localeCompare(String(b._id))
        );
      });

      const recentRows = [...companyTickets]
        .sort(
          (a, b) =>
            timeOf(b.updatedAt || b.createdAt) -
              timeOf(a.updatedAt || a.createdAt) ||
            String(b._id).localeCompare(String(a._id)),
        )
        .slice(0, PAGE_SIZE);

      const urgentRows = urgentTickets.slice(0, PAGE_SIZE);

      const customerUids = [
        ...new Set(
          [...recentRows, ...urgentRows]
            .map((ticket) => ticket.uid)
            .filter((uid) => typeof uid === "string" && uid),
        ),
      ];

      const customers = customerUids.length
        ? await users
            .find(
              {
                ...scope,
                role: "customer",
                uid: { $in: customerUids },
              },
              {
                projection: {
                  uid: 1,
                  displayName: 1,
                  email: 1,
                  photoURL: 1,
                },
              },
            )
            .toArray()
        : [];

      const customerMap = new Map(
        customers.map((customer) => [customer.uid, customer]),
      );

      const agentMap = new Map(agents.map((agent) => [agent.uid, agent]));

      const formatTicket = (ticket) => {
        const customer = customerMap.get(ticket.uid);
        const assignedAgent = agentMap.get(ticket.currentAgent?.uid);

        const userInfo = customer
          ? {
              uid: customer.uid,
              displayName: customer.displayName || null,
              email: customer.email || null,
              photoURL: customer.photoURL || null,
            }
          : null;

        return {
          _id: ticket._id,
          uid: ticket.uid,
          ticketNumber: ticket.ticketNumber,
          status: ticket.status,
          supportMode: ticket.supportMode,
          aiResolved: ticket.aiResolved === true,
          resolutionSource: ticket.resolutionSource || null,
          priority: getPriority(ticket),
          createdAt: ticket.createdAt,
          updatedAt: ticket.updatedAt,
          resolvedAt: ticket.resolvedAt || null,

          aiResult: {
            ticketTitle: ticket.aiResult?.ticketTitle || null,
            summary: ticket.aiResult?.summary || null,
            category: ticket.aiResult?.category || null,
          },

          userInfo,
          customerName: userInfo?.displayName || null,
          email: userInfo?.email || null,

          currentAgent: ticket.currentAgent?.uid
            ? {
                uid: ticket.currentAgent.uid,
                displayName: assignedAgent?.displayName || null,
                name: assignedAgent?.displayName || null,
                email: assignedAgent?.email || null,
                updatedAt: ticket.currentAgent.updatedAt || null,
              }
            : null,
        };
      };

      const approved = agents.filter(
        (agent) => agent.verifyIdAgent === "approved",
      );

      const pending = agents
        .filter((agent) => agent.verifyIdAgent === "pending")
        .sort(
          (a, b) =>
            timeOf(a.createdAt) - timeOf(b.createdAt) ||
            String(a._id).localeCompare(String(b._id)),
        );

      return res.send({
        success: true,
        company: companyInfo(req.managerCompany),

        metrics: {
          totalTickets: companyTickets.length,
          unassignedTickets,
          activeHumanTickets,
          resolvedTickets: statusChart.resolved + statusChart.closed,
          resolvedByAi: resolutionChart.ai,
          resolvedByAgent: resolutionChart.agent,
          unknownResolution: resolutionChart.unknown,
          urgentTickets: urgentTickets.length,
          pendingAgentApprovals: pending.length,
        },

        statusChart,
        resolutionChart,
        activityChart,

        pendingAgentApprovals: pending.slice(0, PAGE_SIZE),
        recentTickets: recentRows.map(formatTicket),
        urgentTickets: urgentRows.map(formatTicket),
        notifications: recentNotifications,

        agentSummary: {
          total: agents.length,
          approved: approved.length,
          activeApproved: approved.filter((agent) => agent.status === "active")
            .length,
          pending: pending.length,
          rejected: agents.filter((agent) => agent.verifyIdAgent === "rejected")
            .length,
          limit: null,
          remainingSeats: null,
        },

        customerSummary: {
          total: customerTotal,
          active: activeCustomerTotal,
        },

        meta: {
          generatedAt: now,
          timezone: "Asia/Dhaka",
          listLimit: PAGE_SIZE,
          agentLimitConfigured: false,
          activityPeriod: {
            from: activityChart[0].day,
            to: activityChart[6].day,
          },
          activityResolutionBasis:
            "Currently resolved/closed tickets grouped by resolvedAt",
        },
      });
    }),
  );

  // =====================================================
  // GET /manager/agents
  // ?page=1&search=&approval=pending&status=active
  // =====================================================

  router.get(
    "/manager/agents",
    ...protectedRoute,
    handle(async (req, res) => {
      const page = getPage(req.query.page);
      const search = queryText(req.query.search, "search").toLowerCase();
      const approval = queryText(req.query.approval, "approval", 20);
      const status = queryText(req.query.status, "status", 20);

      if (approval && !["approved", "pending", "rejected"].includes(approval)) {
        fail(400, "Invalid approval filter");
      }

      if (status && !["active", "suspended"].includes(status)) {
        fail(400, "Invalid account status filter");
      }

      const { agents, companyTickets } = await loadCompanyData(
        req.managerScope,
      );

      const enrichedAgents = buildAgentMetrics(agents, companyTickets);

      const counts = {
        total: enrichedAgents.length,
        approved: enrichedAgents.filter(
          (agent) => agent.verifyIdAgent === "approved",
        ).length,
        pending: enrichedAgents.filter(
          (agent) => agent.verifyIdAgent === "pending",
        ).length,
        rejected: enrichedAgents.filter(
          (agent) => agent.verifyIdAgent === "rejected",
        ).length,
        suspended: enrichedAgents.filter(
          (agent) => agent.status === "suspended",
        ).length,
        totalSolved: enrichedAgents.reduce(
          (total, agent) => total + agent.solvedCount,
          0,
        ),
      };

      const filteredAgents = enrichedAgents
        .filter((agent) => {
          if (approval && agent.verifyIdAgent !== approval) {
            return false;
          }

          if (status && agent.status !== status) {
            return false;
          }

          if (!search) return true;

          return (
            String(agent.displayName || "")
              .toLowerCase()
              .includes(search) ||
            String(agent.email || "")
              .toLowerCase()
              .includes(search)
          );
        })
        .sort(
          (a, b) =>
            timeOf(b.createdAt) - timeOf(a.createdAt) ||
            String(b._id).localeCompare(String(a._id)),
        );

      const { rows, pagination } = paginate(filteredAgents, page);

      return res.send({
        success: true,
        company: companyInfo(req.managerCompany),
        counts,
        seats: getSeats(counts.approved),
        agents: rows,
        pagination,
      });
    }),
  );

  // =====================================================
  // GET /manager/agents/:uid
  // ?solvedPage=1
  // =====================================================

  router.get(
    "/manager/agents/:uid",
    ...protectedRoute,
    handle(async (req, res) => {
      const uid = validateUid(req.params.uid);
      const page = getPage(req.query.solvedPage, "solvedPage");
      const scope = req.managerScope;

      const agent = await users.findOne(
        {
          ...scope,
          uid,
          role: "agent",
        },
        { projection: personProjection },
      );

      if (!agent) {
        fail(404, "Agent not found");
      }

      const solvedFilter = {
        ...scope,
        "resolvedBy.uid": uid,
        status: { $in: COMPLETED_STATUSES },
      };

      const [activeCount, solvedCount] = await Promise.all([
        tickets.countDocuments({
          ...scope,
          "currentAgent.uid": uid,
          status: { $in: ACTIVE_STATUSES },
        }),

        tickets.countDocuments(solvedFilter),
      ]);

      const totalPages = Math.max(1, Math.ceil(solvedCount / PAGE_SIZE));
      const currentPage = Math.min(page, totalPages);

      const solvedTickets = await tickets
        .find(solvedFilter, {
          projection: {
            _id: 1,
            ticketNumber: 1,
            status: 1,
            resolvedAt: 1,
            "aiResult.ticketTitle": 1,
            "aiResult.category": 1,
          },
        })
        .sort({ resolvedAt: -1, _id: -1 })
        .skip((currentPage - 1) * PAGE_SIZE)
        .limit(PAGE_SIZE)
        .toArray();

      return res.send({
        success: true,
        agent: {
          ...agent,
          activeCount,
          solvedCount,
          solvedTickets,
          permission: permissions(agent),
        },
        solvedPagination: {
          page: currentPage,
          limit: PAGE_SIZE,
          total: solvedCount,
          totalPages,
          hasNextPage: currentPage < totalPages,
          hasPreviousPage: currentPage > 1,
        },
      });
    }),
  );

  // =====================================================
  // PATCH /manager/agents/:uid/action
  // =====================================================

  router.patch(
    "/manager/agents/:uid/action",
    ...protectedRoute,
    handle(async (req, res) => {
      const uid = validateUid(req.params.uid);
      const body = req.body;

      if (!body || typeof body !== "object" || Array.isArray(body)) {
        fail(400, "A JSON object is required");
      }

      if (
        Object.keys(body).some((key) => !["action", "reason"].includes(key))
      ) {
        fail(400, "Only action and reason are allowed");
      }

      const { action } = body;

      if (!["approve", "reject", "suspend", "activate"].includes(action)) {
        fail(400, "Invalid agent action");
      }

      if (body.reason != null && typeof body.reason !== "string") {
        fail(400, "Reason must be a string");
      }

      const reason = (body.reason || "").trim();

      if (reason.length > 300) {
        fail(400, "Reason must not exceed 300 characters");
      }

      if (action === "reject" && !reason) {
        fail(400, "Please provide a rejection reason");
      }

      if (!["approve", "reject"].includes(action) && reason) {
        fail(400, "Reason is only supported for approval or rejection");
      }

      const agentFilter = {
        ...req.managerScope,
        uid,
        role: "agent",
      };

      const agent = await users.findOne(agentFilter, {
        projection: { _id: 1 },
      });

      if (!agent) {
        fail(404, "Agent not found");
      }

      const now = new Date();
      const changes = { updatedAt: now };
      const updateFilter = {
        ...agentFilter,
        _id: agent._id,
      };

      let message;

      if (action === "approve") {
        updateFilter.verifyIdAgent = { $in: ["pending", "rejected"] };
        changes.verifyIdAgent = "approved";
        changes.rejectionReason = "";
        changes.approvedReason = reason;
        changes.approvedAt = now;
        changes.approvedBy = {
          uid: req.manager.uid,
          displayName: req.manager.displayName || null,
          email: req.manager.email || null,
          role: req.manager.role,
          approvedAt: now,
        };
        message = "Agent approved successfully";
      } else if (action === "reject") {
        updateFilter.verifyIdAgent = "pending";
        changes.verifyIdAgent = "rejected";
        changes.rejectionReason = reason;
        changes.approvedReason = "";
        changes.approvedBy = null;
        changes.approvedAt = null;
        message = "Agent application rejected";
      } else if (action === "suspend") {
        updateFilter.verifyIdAgent = "approved";
        updateFilter.status = "active";
        changes.status = "suspended";
        message = "Agent account suspended";
      } else {
        updateFilter.verifyIdAgent = "approved";
        updateFilter.status = "suspended";
        changes.status = "active";
        message = "Agent account activated";
      }

      const updatedAgent = await users.findOneAndUpdate(
        updateFilter,
        { $set: changes },
        {
          returnDocument: "after",
          includeResultMetadata: false,
          projection: personProjection,
        },
      );

      if (!updatedAgent) {
        const errors = {
          approve: "Only pending or rejected agents can be approved",
          reject: "Only pending agents can be rejected",
          suspend: "Only active approved agents can be suspended",
          activate: "Only suspended approved agents can be activated",
        };

        fail(409, `${errors[action]}. Refresh the page and try again.`);
      }

      let notificationSaved = false;

      if (typeof createNotification === "function") {
        const results = await Promise.allSettled([
          createNotification({
            uid: updatedAgent.uid,
            userEmail: updatedAgent.email,
            companyId: req.managerCompanyId,
            title: message,
            message:
              action === "reject"
                ? `Your agent application was rejected. Reason: ${reason}`
                : action === "suspend"
                  ? "Your agent account has been suspended."
                  : action === "activate"
                    ? "Your approved agent account is active again."
                    : reason
                      ? `Your agent application has been approved. Note: ${reason}`
                      : "Your agent application has been approved.",
            type: "general",
            path: "/notifications",
          }),

          createNotification({
            uid: req.manager.uid,
            userEmail: req.manager.email,
            companyId: req.managerCompanyId,
            title: message,
            message: `${updatedAgent.displayName || updatedAgent.email || "Agent"}: ${action}.`,
            type: "general",
            path: "/manager/agents",
          }),
        ]);

        notificationSaved = results.every(
          (result) => result.status === "fulfilled",
        );

        for (const result of results) {
          if (result.status === "rejected") {
            console.error(
              "Manager notification failed:",
              result.reason?.message || "Unknown error",
            );
          }
        }
      }

      return res.send({
        success: true,
        message,
        agent: {
          ...updatedAgent,
          permission: permissions(updatedAgent),
        },
        notificationSaved,
      });
    }),
  );

  // =====================================================
  // MANAGER TICKET HELPERS
  // =====================================================

  const mtTicketId = (value) => {
    if (typeof value !== "string" || !/^[a-f\d]{24}$/i.test(value)) {
      fail(400, "Invalid ticket id");
    }

    return new ObjectId(value);
  };

  const mtCanAssign = (ticket) => {
    if (ticket.supportMode === "ai") return false;

    const agentUid = ticket.currentAgent?.uid;

    return (
      (ticket.status === "open" && !agentUid) ||
      (["assigned", "in_progress"].includes(ticket.status) && Boolean(agentUid))
    );
  };

  const mtCsvFilter = (value, name, allowed) => {
    const text = queryText(value, name, 100);

    if (!text) return [];

    const values = [
      ...new Set(text.split(",").map((item) => item.trim().toLowerCase())),
    ];

    if (values.some((item) => !allowed.includes(item))) {
      fail(400, `Invalid ${name} filter`);
    }

    return values;
  };

  const mtBooleanFilter = (value, name) => {
    if (value == null || value === "") return false;
    if (value === "true") return true;
    if (value === "false") return false;

    fail(400, `${name} must be true or false`);
  };

  const mtPerson = (person) =>
    person
      ? {
          uid: person.uid,
          displayName: person.displayName || null,
          email: person.email || null,
          photoURL: person.photoURL || null,
          status: person.status || null,
        }
      : null;

  const mtFormatTicket = (ticket, personMap) => {
    const customer = personMap.get(ticket.uid);
    const assigned = personMap.get(ticket.currentAgent?.uid);

    const userInfo = customer?.role === "customer" ? mtPerson(customer) : null;

    const agentInfo = assigned?.role === "agent" ? mtPerson(assigned) : null;

    const completed = ["resolved", "closed"].includes(ticket.status);

    return {
      _id: ticket._id,
      ticketNumber: ticket.ticketNumber,
      uid: ticket.uid,
      status: ticket.status,
      supportMode: ticket.supportMode,
      humanSupport: ticket.supportMode !== "ai",
      aiResolved: ticket.aiResolved === true,

      priority: getPriority(ticket),

      resolutionSource: completed ? getResolutionSource(ticket) : null,

      aiResult: {
        ticketTitle: ticket.aiResult?.ticketTitle || null,
        summary: ticket.aiResult?.summary || null,
        category: ticket.aiResult?.category || null,
      },

      userInfo,
      agentUid: ticket.currentAgent?.uid || null,
      agentInfo,

      currentAgent: ticket.currentAgent?.uid
        ? {
            uid: ticket.currentAgent.uid,
            updatedAt: ticket.currentAgent.updatedAt || null,
            displayName: agentInfo?.displayName || null,
            email: agentInfo?.email || null,
            status: agentInfo?.status || null,
          }
        : null,

      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt,
      resolvedAt: ticket.resolvedAt || null,

      permission: {
        canManageAssignment: mtCanAssign(ticket),
        canAssign: mtCanAssign(ticket) && !ticket.currentAgent?.uid,
        canReassign: mtCanAssign(ticket) && !!ticket.currentAgent?.uid,
      },
    };
  };

  const mtPeople = async (scope, uids) => {
    const uniqueUids = [
      ...new Set(uids.filter((uid) => typeof uid === "string" && uid)),
    ];

    if (!uniqueUids.length) return new Map();

    const people = await users
      .find(
        {
          ...scope,
          uid: { $in: uniqueUids },
          role: { $in: ["customer", "agent", "manager", "owner"] },
        },
        {
          projection: {
            uid: 1,
            role: 1,
            displayName: 1,
            email: 1,
            photoURL: 1,
            status: 1,
          },
        },
      )
      .toArray();

    return new Map(people.map((person) => [person.uid, person]));
  };

  // =====================================================
  // GET /manager/tickets
  // =====================================================

  router.get(
    "/manager/tickets",
    ...protectedRoute,
    handle(async (req, res) => {
      const scope = req.managerScope;

      const page = getPage(req.query.page);
      const search = queryText(req.query.search, "search").toLowerCase();

      const queue = queryText(req.query.queue, "queue", 20);
      const category = queryText(
        req.query.category,
        "category",
        100,
      ).toLowerCase();

      const agentFilter = queryText(req.query.agent, "agent", 128);
      const resolution = queryText(req.query.resolution, "resolution", 20);

      const statuses = mtCsvFilter(req.query.status, "status", [
        "open",
        "assigned",
        "in_progress",
        "resolved",
        "closed",
      ]);

      const priorities = mtCsvFilter(req.query.priority, "priority", [
        "low",
        "medium",
        "high",
        "critical",
      ]);

      const onlyUnassigned = mtBooleanFilter(
        req.query.unassigned,
        "unassigned",
      );

      const onlyUnresolved = mtBooleanFilter(
        req.query.unresolved,
        "unresolved",
      );

      if (queue && !["unassigned", "active"].includes(queue)) {
        fail(400, "Invalid queue filter");
      }

      if (resolution && !["ai", "agent", "unknown"].includes(resolution)) {
        fail(400, "Invalid resolution filter");
      }

      const companyTickets = await tickets
        .find(scope, { projection: ticketProjection })
        .toArray();

      const personMap = await mtPeople(
        scope,
        companyTickets.flatMap((ticket) => [
          ticket.uid,
          ticket.currentAgent?.uid,
        ]),
      );

      const rows = companyTickets.map((ticket) =>
        mtFormatTicket(ticket, personMap),
      );

      const isUnassigned = (ticket) =>
        ticket.humanSupport && ticket.status === "open" && !ticket.agentUid;

      const counts = {
        total: rows.length,
        unassigned: rows.filter(isUnassigned).length,
        active: rows.filter((ticket) =>
          ["assigned", "in_progress"].includes(ticket.status),
        ).length,
        resolved: rows.filter((ticket) => ticket.status === "resolved").length,
        closed: rows.filter((ticket) => ticket.status === "closed").length,
      };

      const filtered = rows
        .filter((ticket) => {
          if (
            (queue === "unassigned" || onlyUnassigned) &&
            !isUnassigned(ticket)
          ) {
            return false;
          }

          if (
            queue === "active" &&
            !["assigned", "in_progress"].includes(ticket.status)
          ) {
            return false;
          }

          if (
            onlyUnresolved &&
            !["open", "assigned", "in_progress"].includes(ticket.status)
          ) {
            return false;
          }

          if (statuses.length && !statuses.includes(ticket.status)) {
            return false;
          }

          if (priorities.length && !priorities.includes(ticket.priority)) {
            return false;
          }

          if (
            category &&
            String(ticket.aiResult.category || "")
              .trim()
              .toLowerCase() !== category
          ) {
            return false;
          }

          if (agentFilter === "unassigned" && !isUnassigned(ticket)) {
            return false;
          }

          if (
            agentFilter &&
            agentFilter !== "unassigned" &&
            ticket.agentUid !== agentFilter
          ) {
            return false;
          }

          if (resolution && ticket.resolutionSource !== resolution) {
            return false;
          }

          return (
            !search ||
            [
              ticket.ticketNumber,
              ticket.aiResult.ticketTitle,
              ticket.userInfo?.displayName,
              ticket.userInfo?.email,
            ].some((value) =>
              String(value || "")
                .toLowerCase()
                .includes(search),
            )
          );
        })
        .sort(
          (a, b) =>
            timeOf(b.updatedAt || b.createdAt) -
              timeOf(a.updatedAt || a.createdAt) ||
            String(b._id).localeCompare(String(a._id)),
        );

      const result = paginate(filtered, page);

      return res.send({
        success: true,
        company: companyInfo(req.managerCompany),
        counts,
        tickets: result.rows,
        pagination: result.pagination,
      });
    }),
  );

  // =====================================================
  // GET /manager/tickets/:id
  // Full informative ticket details for manager & owner
  // =====================================================

  router.get(
    "/manager/tickets/:id",
    ...protectedRoute,
    handle(async (req, res) => {
      const id = mtTicketId(req.params.id);
      const historyPage = getPage(req.query.historyPage, "historyPage");

      const ticket = await tickets.findOne({
        ...req.managerScope,
        _id: id,
      });

      if (!ticket) fail(404, "Ticket not found");

      const personMap = await mtPeople(req.managerScope, [
        ticket.uid,
        ticket.currentAgent?.uid,
        ticket.resolvedBy?.uid,
      ]);

      const history = (
        Array.isArray(ticket.actionHistory) ? ticket.actionHistory : []
      )
        .filter((item) =>
          [
            "assigned",
            "reassigned",
            "unassigned",
            "released",
            "resolved",
          ].includes(item.action),
        )
        .map((item) => ({
          action: item.action,
          agentUid: item.agentUid || (item.role === "agent" ? item.uid : null),
          actorUid: item.uid || null,
          actorRole: item.role || null,
          assignedAt: item.date || null,
          note:
            item.action === "reassigned"
              ? "Ticket reassigned"
              : item.action === "unassigned" || item.action === "released"
                ? "Agent unassigned"
                : item.action === "resolved"
                  ? "Ticket resolved"
                  : "Ticket assigned",
        }))
        .sort((a, b) => timeOf(b.assignedAt) - timeOf(a.assignedAt));

      const historyResult = paginate(history, historyPage);

      const historyPeople = await mtPeople(
        req.managerScope,
        historyResult.rows.map((item) => item.agentUid),
      );

      const formatted = mtFormatTicket(ticket, personMap);
      const resolvedByPerson = personMap.get(ticket.resolvedBy?.uid);
      const isClosedOrResolved = ["resolved", "closed"].includes(ticket.status);
      const isHumanTicket =
        ticket.aiResolved !== true && ticket.supportMode !== "ai";

      const detailedTicket = {
        ...formatted,
        category: ticket.aiResult?.category || ticket.category || null,
        subject: ticket.subject || ticket.ticketData?.subject || null,
        description:
          typeof ticket.ticketData === "string"
            ? ticket.ticketData
            : ticket.ticketData?.description || ticket.description || "",
        ticketData: ticket.ticketData || null,
        aiResult: ticket.aiResult || {},
        currentAgentInfo: formatted.agentInfo,
        resolvedByInfo: resolvedByPerson ? mtPerson(resolvedByPerson) : null,
        permission: {
          ...formatted.permission,
          canRead: true,
          canReadMessages: isHumanTicket,
          canSendMessage: isHumanTicket && !isClosedOrResolved,
          canAssign:
            isHumanTicket && !isClosedOrResolved && mtCanAssign(ticket),
          canRelease:
            isHumanTicket &&
            !isClosedOrResolved &&
            Boolean(ticket.currentAgent?.uid),
          canUnassign:
            isHumanTicket &&
            !isClosedOrResolved &&
            Boolean(ticket.currentAgent?.uid),
          canResolve: isHumanTicket && !isClosedOrResolved,
        },
        assignmentHistory: historyResult.rows.map((item) => {
          const agent = historyPeople.get(item.agentUid);

          return {
            ...item,
            agentInfo: agent?.role === "agent" ? mtPerson(agent) : null,
          };
        }),
      };

      return res.send({
        success: true,
        data: detailedTicket,
        ticket: detailedTicket,
        historyPagination: historyResult.pagination,
      });
    }),
  );

  // =====================================================
  // GET /manager/tickets/:id/eligible-agents
  // =====================================================

  router.get(
    "/manager/tickets/:id/eligible-agents",
    ...protectedRoute,
    handle(async (req, res) => {
      const id = mtTicketId(req.params.id);
      const page = getPage(req.query.page);
      const search = queryText(req.query.search, "search").toLowerCase();

      const ticket = await tickets.findOne(
        { ...req.managerScope, _id: id },
        {
          projection: {
            status: 1,
            supportMode: 1,
            currentAgent: 1,
          },
        },
      );

      if (!ticket) fail(404, "Ticket not found");

      if (!mtCanAssign(ticket)) {
        fail(409, "This ticket cannot be assigned or reassigned");
      }

      const agents = await users
        .find(
          {
            ...req.managerScope,
            role: "agent",
            status: "active",
            verifyIdAgent: "approved",
          },
          {
            projection: {
              uid: 1,
              displayName: 1,
              email: 1,
              photoURL: 1,
              status: 1,
              verifyIdAgent: 1,
            },
          },
        )
        .sort({ displayName: 1, _id: 1 })
        .toArray();

      const filtered = agents.filter(
        (agent) =>
          !search ||
          [agent.displayName, agent.email].some((value) =>
            String(value || "")
              .toLowerCase()
              .includes(search),
          ),
      );

      const result = paginate(filtered, page);

      const rows = await Promise.all(
        result.rows.map(async (agent) => ({
          ...agent,
          isCurrentAgent: agent.uid === ticket.currentAgent?.uid,
          activeCount: await tickets.countDocuments({
            ...req.managerScope,
            "currentAgent.uid": agent.uid,
            status: { $in: ["assigned", "in_progress"] },
          }),
        })),
      );

      return res.send({
        success: true,
        agents: rows,
        pagination: result.pagination,
      });
    }),
  );

  // =====================================================
  // PATCH /manager/tickets/:id/assignment
  // =====================================================

  router.patch(
    "/manager/tickets/:id/assignment",
    ...protectedRoute,
    handle(async (req, res) => {
      const id = mtTicketId(req.params.id);
      const body = req.body;

      if (!body || typeof body !== "object" || Array.isArray(body)) {
        fail(400, "A JSON object is required");
      }

      const allowedFields = ["agentUid", "expectedAgentUid", "expectedStatus"];

      if (Object.keys(body).some((key) => !allowedFields.includes(key))) {
        fail(400, "Unexpected assignment field");
      }

      const agentUid = validateUid(body.agentUid);

      if (!Object.prototype.hasOwnProperty.call(body, "expectedAgentUid")) {
        fail(400, "expectedAgentUid is required");
      }

      const expectedAgentUid =
        body.expectedAgentUid === null
          ? null
          : validateUid(body.expectedAgentUid);

      if (!["open", "assigned", "in_progress"].includes(body.expectedStatus)) {
        fail(400, "Invalid expectedStatus");
      }

      if (!client) {
        fail(500, "MongoDB client is not configured");
      }

      const session = client.startSession();
      let saved;

      try {
        await session.withTransaction(async () => {
          const now = new Date();

          const manager = await users.findOneAndUpdate(
            {
              uid: req.user.uid,
              role: { $in: ["manager", "owner"] },
              status: "active",
              ...req.managerScope,
            },
            { $set: { lastAssignmentActionAt: now } },
            {
              session,
              returnDocument: "after",
              includeResultMetadata: false,
              projection: { uid: 1, companyId: 1 },
            },
          );

          if (!manager) {
            fail(403, "Your access has changed");
          }

          const companyGuard = await companies.updateOne(
            {
              _id: req.managerCompanyId,
              status: "active",
            },
            { $set: { lastTicketAssignmentAt: now } },
            { session },
          );

          if (!companyGuard.matchedCount) {
            fail(403, "Your company is no longer active");
          }

          const ticket = await tickets.findOne(
            {
              ...req.managerScope,
              _id: id,
            },
            { session },
          );

          if (!ticket) fail(404, "Ticket not found");

          if (!mtCanAssign(ticket)) {
            fail(409, "This ticket cannot be assigned or reassigned");
          }

          const previousAgentUid = ticket.currentAgent?.uid || null;

          if (
            previousAgentUid !== expectedAgentUid ||
            ticket.status !== body.expectedStatus
          ) {
            fail(409, "Ticket changed. Refresh and try again.");
          }

          if (previousAgentUid === agentUid) {
            fail(409, "Select a different agent");
          }

          const agent = await users.findOneAndUpdate(
            {
              ...req.managerScope,
              uid: agentUid,
              role: "agent",
              status: "active",
              verifyIdAgent: "approved",
            },
            { $set: { lastAssignedAt: now } },
            {
              session,
              returnDocument: "after",
              includeResultMetadata: false,
              projection: {
                uid: 1,
                displayName: 1,
                email: 1,
              },
            },
          );

          if (!agent) {
            fail(409, "Select an active approved agent from your company");
          }

          const result = await tickets.updateOne(
            {
              ...req.managerScope,
              _id: id,
              status: ticket.status,
              "currentAgent.uid": previousAgentUid,
              supportMode: { $ne: "ai" },
            },
            {
              $set: {
                currentAgent: {
                  uid: agentUid,
                  updatedAt: now,
                },
                status: ticket.status === "open" ? "assigned" : ticket.status,
                updatedAt: now,
              },
              $push: {
                actionHistory: {
                  uid: req.manager.uid,
                  role: req.manager.role,
                  action: previousAgentUid ? "reassigned" : "assigned",
                  agentUid,
                  previousAgentUid,
                  date: now,
                },
              },
            },
            { session },
          );

          if (!result.matchedCount) {
            fail(409, "Ticket changed. Refresh and try again.");
          }

          saved = {
            ticketId: ticket._id,
            ticketNumber: ticket.ticketNumber,
            customerUid: ticket.uid,
            agent,
            previousAgentUid,
            status: ticket.status === "open" ? "assigned" : ticket.status,
            updatedAt: now,
          };
        });
      } finally {
        await session.endSession();
      }

      const message = saved.previousAgentUid
        ? "Ticket reassigned successfully"
        : "Ticket assigned successfully";

      let notificationSaved = false;

      if (typeof createNotification === "function") {
        const recipients = [
          saved.agent.uid,
          saved.customerUid,
          req.manager.uid,
          saved.previousAgentUid,
        ].filter((uid) => typeof uid === "string" && uid);

        const results = await Promise.allSettled(
          [...new Set(recipients)].map((uid) =>
            createNotification({
              uid,
              companyId: req.managerCompanyId,
              title: message,
              message: `${saved.ticketNumber || "Ticket"} was assigned to ${saved.agent.displayName || "an agent"}.`,
              type: "ticket_assigned",
              ticketId: saved.ticketId,
              ticketNumber: saved.ticketNumber,
              path: "/notifications",
            }),
          ),
        );

        notificationSaved = results.every(
          (result) => result.status === "fulfilled",
        );

        for (const result of results) {
          if (result.status === "rejected") {
            console.error(
              "Assignment notification failed:",
              result.reason?.message || "Unknown error",
            );
          }
        }
      }

      return res.send({
        success: true,
        message,
        ticket: {
          _id: saved.ticketId,
          status: saved.status,
          agentUid: saved.agent.uid,
          currentAgent: {
            uid: saved.agent.uid,
            displayName: saved.agent.displayName || null,
            email: saved.agent.email || null,
            updatedAt: saved.updatedAt,
          },
          updatedAt: saved.updatedAt,
        },
        notificationSaved,
      });
    }),
  );

  // =====================================================
  // PATCH /manager/tickets/:id/assign
  // Body: { agentUid: "..." }
  // =====================================================

  router.patch(
    "/manager/tickets/:id/assign",
    ...protectedRoute,
    handle(async (req, res) => {
      const id = mtTicketId(req.params.id);
      const body = req.body;

      if (!body || typeof body !== "object" || Array.isArray(body)) {
        fail(400, "A JSON object is required");
      }

      const agentUid = validateUid(body.agentUid);

      if (!client) {
        fail(500, "MongoDB client is not configured");
      }

      const session = client.startSession();
      let saved;

      try {
        await session.withTransaction(async () => {
          const now = new Date();

          const ticket = await tickets.findOne(
            {
              ...req.managerScope,
              _id: id,
            },
            { session },
          );

          if (!ticket) fail(404, "Ticket not found");

          if (
            ["resolved", "closed"].includes(ticket.status) ||
            ticket.aiResolved === true ||
            !mtCanAssign(ticket)
          ) {
            fail(409, "This ticket cannot be assigned or reassigned");
          }

          const previousAgentUid = ticket.currentAgent?.uid || null;

          if (previousAgentUid === agentUid) {
            fail(409, "This agent is already assigned to the ticket");
          }

          const agent = await users.findOneAndUpdate(
            {
              ...req.managerScope,
              uid: agentUid,
              role: "agent",
              status: "active",
              verifyIdAgent: "approved",
            },
            { $set: { lastAssignedAt: now } },
            {
              session,
              returnDocument: "after",
              includeResultMetadata: false,
              projection: {
                uid: 1,
                displayName: 1,
                email: 1,
              },
            },
          );

          if (!agent) {
            fail(409, "Select an active approved agent from your company");
          }

          const nextStatus =
            ticket.status === "open" ? "assigned" : ticket.status;

          const result = await tickets.updateOne(
            {
              ...req.managerScope,
              _id: id,
              status: ticket.status,
              "currentAgent.uid": previousAgentUid,
              aiResolved: { $ne: true },
            },
            {
              $set: {
                supportMode: "human",
                currentAgent: {
                  uid: agentUid,
                  updatedAt: now,
                },
                status: nextStatus,
                updatedAt: now,
              },
              $push: {
                actionHistory: {
                  uid: req.manager.uid,
                  role: req.manager.role,
                  action: previousAgentUid ? "reassigned" : "assigned",
                  agentUid,
                  previousAgentUid,
                  date: now,
                },
              },
            },
            { session },
          );

          if (!result.matchedCount) {
            fail(409, "Ticket changed. Refresh and try again.");
          }

          saved = {
            ticketId: ticket._id,
            ticketNumber: ticket.ticketNumber,
            customerUid: ticket.uid,
            agent,
            previousAgentUid,
            status: nextStatus,
            updatedAt: now,
          };
        });
      } finally {
        await session.endSession();
      }

      const message = saved.previousAgentUid
        ? "Ticket reassigned successfully"
        : "Ticket assigned successfully";

      if (typeof createNotification === "function") {
        const recipients = [
          { uid: saved.agent.uid, path: `/agent/tickets/${saved.ticketId}` },
          {
            uid: saved.customerUid,
            path: `/customer/tickets/${saved.ticketId}`,
          },
          {
            uid: req.manager.uid,
            path: `/manager/tickets/${saved.ticketId}`,
          },
          ...(saved.previousAgentUid
            ? [{ uid: saved.previousAgentUid, path: "/agent/my-tickets" }]
            : []),
        ].filter((item) => typeof item.uid === "string" && item.uid);

        await Promise.allSettled(
          recipients.map((item) =>
            createNotification({
              uid: item.uid,
              companyId: req.managerCompanyId,
              title: message,
              message: `${saved.ticketNumber || "Ticket"} was assigned to ${saved.agent.displayName || "an agent"}.`,
              type: "ticket_assigned",
              ticketId: saved.ticketId,
              ticketNumber: saved.ticketNumber,
              path: item.path,
            }),
          ),
        );
      }

      return res.send({
        success: true,
        message,
        ticket: {
          _id: saved.ticketId,
          status: saved.status,
          agentUid: saved.agent.uid,
          currentAgent: {
            uid: saved.agent.uid,
            displayName: saved.agent.displayName || null,
            email: saved.agent.email || null,
            updatedAt: saved.updatedAt,
          },
          updatedAt: saved.updatedAt,
        },
      });
    }),
  );

  // =====================================================
  // PATCH /manager/tickets/:id/unassign
  // =====================================================

  router.patch(
    "/manager/tickets/:id/unassign",
    ...protectedRoute,
    handle(async (req, res) => {
      const id = mtTicketId(req.params.id);

      const ticket = await tickets.findOne({
        ...req.managerScope,
        _id: id,
      });

      if (!ticket) fail(404, "Ticket not found");

      if (
        ["resolved", "closed"].includes(ticket.status) ||
        ticket.aiResolved === true ||
        !ticket.currentAgent?.uid
      ) {
        fail(409, "This ticket cannot be unassigned right now");
      }

      const previousAgentUid = ticket.currentAgent.uid;
      const now = new Date();

      const result = await tickets.updateOne(
        {
          ...req.managerScope,
          _id: id,
          status: ticket.status,
          "currentAgent.uid": previousAgentUid,
        },
        {
          $set: {
            currentAgent: null,
            status: "open",
            updatedAt: now,
          },
          $push: {
            actionHistory: {
              uid: req.manager.uid,
              role: req.manager.role,
              action: "unassigned",
              previousAgentUid,
              date: now,
            },
          },
        },
      );

      if (!result.matchedCount) {
        fail(409, "Ticket changed. Refresh and try again.");
      }

      if (typeof createNotification === "function") {
        const recipients = [
          { uid: previousAgentUid, path: "/agent/my-tickets" },
          { uid: ticket.uid, path: `/customer/tickets/${ticket._id}` },
          { uid: req.manager.uid, path: `/manager/tickets/${ticket._id}` },
        ].filter((item) => typeof item.uid === "string" && item.uid);

        await Promise.allSettled(
          recipients.map((item) =>
            createNotification({
              uid: item.uid,
              companyId: req.managerCompanyId,
              title: "Agent unassigned from ticket",
              message: `${ticket.ticketNumber || "Ticket"} was returned to the open queue.`,
              type: "ticket_released",
              ticketId: ticket._id,
              ticketNumber: ticket.ticketNumber,
              path: item.path,
            }),
          ),
        );
      }

      return res.send({
        success: true,
        message: "Agent unassigned from ticket",
        ticket: {
          _id: ticket._id,
          status: "open",
          agentUid: null,
          currentAgent: null,
          updatedAt: now,
        },
      });
    }),
  );

  // =====================================================
  // PATCH /manager/tickets/:id/resolve
  // =====================================================

  router.patch(
    "/manager/tickets/:id/resolve",
    ...protectedRoute,
    handle(async (req, res) => {
      const id = mtTicketId(req.params.id);

      const ticket = await tickets.findOne({
        ...req.managerScope,
        _id: id,
      });

      if (!ticket) fail(404, "Ticket not found");

      if (
        ["resolved", "closed"].includes(ticket.status) ||
        ticket.aiResolved === true
      ) {
        fail(409, "This ticket cannot be resolved in its current status");
      }

      const now = new Date();

      const result = await tickets.updateOne(
        {
          ...req.managerScope,
          _id: id,
          status: ticket.status,
          aiResolved: { $ne: true },
        },
        {
          $set: {
            status: "resolved",
            resolutionSource: "agent",
            resolvedAt: now,
            resolvedBy: {
              uid: req.manager.uid,
              role: req.manager.role,
              updatedAt: now,
            },
            updatedAt: now,
          },
          $push: {
            actionHistory: {
              uid: req.manager.uid,
              role: req.manager.role,
              action: "resolved",
              date: now,
            },
          },
        },
      );

      if (!result.matchedCount) {
        fail(409, "Ticket changed. Refresh and try again.");
      }

      if (typeof createNotification === "function") {
        const recipients = [
          { uid: ticket.uid, path: `/customer/tickets/${ticket._id}` },
          ...(ticket.currentAgent?.uid
            ? [
                {
                  uid: ticket.currentAgent.uid,
                  path: `/agent/tickets/${ticket._id}`,
                },
              ]
            : []),
        ].filter((item) => typeof item.uid === "string" && item.uid);

        await Promise.allSettled(
          recipients.map((item) =>
            createNotification({
              uid: item.uid,
              companyId: req.managerCompanyId,
              title: "Ticket Resolved",
              message: `Ticket ${ticket.ticketNumber || ""} has been marked as resolved.`,
              type: "ticket_resolved",
              ticketId: ticket._id,
              ticketNumber: ticket.ticketNumber,
              path: item.path,
            }),
          ),
        );
      }

      return res.send({
        success: true,
        message: "Ticket resolved successfully",
      });
    }),
  );

  // =====================================================
  // GET /manager/customers
  // Query: ?page=1&search=&status=active&activity=has_active
  // =====================================================

  router.get(
    "/manager/customers",
    ...protectedRoute,
    handle(async (req, res) => {
      const scope = req.managerScope;
      const page = getPage(req.query.page);
      const search = queryText(req.query.search, "search").toLowerCase();
      const status = queryText(req.query.status, "status", 20);
      const activity = queryText(req.query.activity, "activity", 20);

      if (status && !["active", "suspended"].includes(status)) {
        fail(400, "Invalid account status filter");
      }

      if (activity && !["has_active", "no_active"].includes(activity)) {
        fail(400, "Invalid ticket activity filter");
      }

      const [customers, companyTickets] = await Promise.all([
        users
          .find(
            { ...scope, role: "customer" },
            { projection: personProjection },
          )
          .toArray(),
        tickets
          .find(scope, {
            projection: {
              _id: 1,
              uid: 1,
              status: 1,
              createdAt: 1,
            },
          })
          .toArray(),
      ]);

      const OPEN_CUSTOMER_STATUSES = [
        "open",
        "assigned",
        "in_progress",
        "reopened",
      ];

      const ticketMap = new Map();

      for (const ticket of companyTickets) {
        if (!ticket.uid) continue;

        const entry = ticketMap.get(ticket.uid) || {
          totalTickets: 0,
          activeCount: 0,
          solvedCount: 0,
          lastTicketAt: null,
        };

        entry.totalTickets += 1;

        if (OPEN_CUSTOMER_STATUSES.includes(ticket.status)) {
          entry.activeCount += 1;
        } else if (COMPLETED_STATUSES.includes(ticket.status)) {
          entry.solvedCount += 1;
        }

        if (timeOf(ticket.createdAt) > timeOf(entry.lastTicketAt)) {
          entry.lastTicketAt = ticket.createdAt;
        }

        ticketMap.set(ticket.uid, entry);
      }

      const enrichedCustomers = customers.map((customer) => {
        const stats = ticketMap.get(customer.uid) || {
          totalTickets: 0,
          activeCount: 0,
          solvedCount: 0,
          lastTicketAt: null,
        };

        return {
          ...customer,
          ...stats,
          permission: {
            canSuspend: customer.status === "active",
            canActivate: customer.status === "suspended",
          },
        };
      });

      const counts = {
        total: enrichedCustomers.length,
        activeAccounts: enrichedCustomers.filter((c) => c.status === "active")
          .length,
        suspendedAccounts: enrichedCustomers.filter(
          (c) => c.status === "suspended",
        ).length,
        withActiveTickets: enrichedCustomers.filter((c) => c.activeCount > 0)
          .length,
        totalTickets: enrichedCustomers.reduce(
          (sum, c) => sum + c.totalTickets,
          0,
        ),
      };

      const filteredCustomers = enrichedCustomers
        .filter((customer) => {
          if (status && customer.status !== status) return false;
          if (activity === "has_active" && customer.activeCount === 0) {
            return false;
          }
          if (activity === "no_active" && customer.activeCount > 0) {
            return false;
          }

          if (!search) return true;

          return (
            String(customer.displayName || "")
              .toLowerCase()
              .includes(search) ||
            String(customer.email || "")
              .toLowerCase()
              .includes(search)
          );
        })
        .sort(
          (a, b) =>
            timeOf(b.createdAt) - timeOf(a.createdAt) ||
            String(b._id).localeCompare(String(a._id)),
        );

      const { rows, pagination } = paginate(filteredCustomers, page);

      return res.send({
        success: true,
        company: companyInfo(req.managerCompany),
        counts,
        customers: rows,
        pagination,
      });
    }),
  );

  // =====================================================
  // GET /manager/customers/:uid
  // Query: ?ticketPage=1
  // =====================================================

  router.get(
    "/manager/customers/:uid",
    ...protectedRoute,
    handle(async (req, res) => {
      const uid = validateUid(req.params.uid);
      const page = getPage(req.query.ticketPage, "ticketPage");
      const scope = req.managerScope;

      const customer = await users.findOne(
        { ...scope, uid, role: "customer" },
        { projection: personProjection },
      );

      if (!customer) {
        fail(404, "Customer not found");
      }

      const ticketFilter = { ...scope, uid };
      const OPEN_CUSTOMER_STATUSES = [
        "open",
        "assigned",
        "in_progress",
        "reopened",
      ];

      const [totalTickets, activeCount, solvedCount] = await Promise.all([
        tickets.countDocuments(ticketFilter),
        tickets.countDocuments({
          ...ticketFilter,
          status: { $in: OPEN_CUSTOMER_STATUSES },
        }),
        tickets.countDocuments({
          ...ticketFilter,
          status: { $in: COMPLETED_STATUSES },
        }),
      ]);

      const totalPages = Math.max(1, Math.ceil(totalTickets / PAGE_SIZE));
      const currentPage = Math.min(page, totalPages);

      const customerTickets = await tickets
        .find(ticketFilter, {
          projection: {
            _id: 1,
            ticketNumber: 1,
            status: 1,
            createdAt: 1,
            "aiResult.ticketTitle": 1,
            "aiResult.category": 1,
          },
        })
        .sort({ createdAt: -1, _id: -1 })
        .skip((currentPage - 1) * PAGE_SIZE)
        .limit(PAGE_SIZE)
        .toArray();

      return res.send({
        success: true,
        customer: {
          ...customer,
          totalTickets,
          activeCount,
          solvedCount,
          tickets: customerTickets,
          permission: {
            canSuspend: customer.status === "active",
            canActivate: customer.status === "suspended",
          },
        },
        ticketPagination: {
          page: currentPage,
          limit: PAGE_SIZE,
          total: totalTickets,
          totalPages,
          hasNextPage: currentPage < totalPages,
          hasPreviousPage: currentPage > 1,
        },
      });
    }),
  );

  // =====================================================
  // PATCH /manager/customers/:uid/action
  // Body: { action: "suspend" | "activate" }
  // =====================================================

  router.patch(
    "/manager/customers/:uid/action",
    ...protectedRoute,
    handle(async (req, res) => {
      const uid = validateUid(req.params.uid);
      const body = req.body;

      if (!body || typeof body !== "object" || Array.isArray(body)) {
        fail(400, "A JSON object is required");
      }

      if (Object.keys(body).some((key) => key !== "action")) {
        fail(400, "Only action is allowed");
      }

      const { action } = body;

      if (!["suspend", "activate"].includes(action)) {
        fail(400, "Invalid customer action");
      }

      const customerFilter = {
        ...req.managerScope,
        uid,
        role: "customer",
      };

      const customer = await users.findOne(customerFilter, {
        projection: { _id: 1 },
      });

      if (!customer) {
        fail(404, "Customer not found");
      }

      const now = new Date();
      const updateFilter = {
        ...customerFilter,
        _id: customer._id,
        status: action === "suspend" ? "active" : "suspended",
      };

      const nextStatus = action === "suspend" ? "suspended" : "active";
      const message =
        action === "suspend"
          ? "Customer account suspended"
          : "Customer account activated";

      const updatedCustomer = await users.findOneAndUpdate(
        updateFilter,
        {
          $set: {
            status: nextStatus,
            updatedAt: now,
          },
        },
        {
          returnDocument: "after",
          includeResultMetadata: false,
          projection: personProjection,
        },
      );

      if (!updatedCustomer) {
        fail(
          409,
          `Only ${action === "suspend" ? "active" : "suspended"} customers can be ${action}d. Refresh and try again.`,
        );
      }

      let notificationSaved = false;

      if (typeof createNotification === "function") {
        const results = await Promise.allSettled([
          createNotification({
            uid: updatedCustomer.uid,
            userEmail: updatedCustomer.email,
            companyId: req.managerCompanyId,
            title: message,
            message:
              action === "suspend"
                ? "Your customer account has been suspended by your workspace manager."
                : "Your customer account access has been restored.",
            type: "general",
            path: "/notifications",
          }),
          createNotification({
            uid: req.manager.uid,
            userEmail: req.manager.email,
            companyId: req.managerCompanyId,
            title: message,
            message: `${updatedCustomer.displayName || updatedCustomer.email || "Customer"}: ${action}.`,
            type: "general",
            path: "/manager/customers",
          }),
        ]);

        notificationSaved = results.every((r) => r.status === "fulfilled");
      }

      return res.send({
        success: true,
        message,
        customer: {
          ...updatedCustomer,
          permission: {
            canSuspend: updatedCustomer.status === "active",
            canActivate: updatedCustomer.status === "suspended",
          },
        },
        notificationSaved,
      });
    }),
  );

  return router;
};
