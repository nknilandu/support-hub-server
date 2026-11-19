const { ObjectId } = require("mongodb");

const DEFAULT_LIMITS = {
  managers: 1,
  agents: 3,
  tickets: 30,
  aiReplies: 50,
};

function getEffectiveLimits(company) {
  const saved = company?.subscription;
  if (!saved || !saved.planId) {
    return {
      planName: "Default Plan",
      isExpired: false,
      limits: DEFAULT_LIMITS,
    };
  }

  const isExpired =
    saved.expiresAt && new Date(saved.expiresAt).getTime() <= Date.now();

  if (isExpired) {
    return {
      planName: "Expired Plan",
      isExpired: true,
      limits: DEFAULT_LIMITS,
    };
  }

  return {
    planName: saved.planName || "Active Plan",
    isExpired: false,
    limits: {
      managers: saved.limits?.managers ?? DEFAULT_LIMITS.managers,
      agents: saved.limits?.agents ?? DEFAULT_LIMITS.agents,
      tickets:
        saved.limits?.tickets !== undefined
          ? saved.limits.tickets
          : DEFAULT_LIMITS.tickets,
      aiReplies:
        saved.limits?.aiReplies !== undefined
          ? saved.limits.aiReplies
          : DEFAULT_LIMITS.aiReplies,
    },
  };
}

function getMonthStartDate() {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0),
  );
}

async function checkTicketCreationLimit({ companies, tickets, companyId }) {
  const companyObjId =
    companyId instanceof ObjectId ? companyId : new ObjectId(companyId);
  const company = await companies.findOne({ _id: companyObjId });
  const { planName, limits } = getEffectiveLimits(company);

  if (limits.tickets === null) return { allowed: true };

  const monthlyTickets = await tickets.countDocuments({
    companyId: { $in: [companyObjId, companyObjId.toHexString()] },
    createdAt: { $gte: getMonthStartDate() },
  });

  if (monthlyTickets >= limits.tickets) {
    return {
      allowed: false,
      message: `Monthly ticket limit (${limits.tickets}) reached for ${planName}. Please ask the workspace owner to upgrade the subscription.`,
    };
  }
  return { allowed: true };
}

async function checkAiReplyLimit({ companies, tickets, companyId }) {
  const companyObjId =
    companyId instanceof ObjectId ? companyId : new ObjectId(companyId);
  const company = await companies.findOne({ _id: companyObjId });
  const { planName, limits } = getEffectiveLimits(company);

  if (limits.aiReplies === null) return { allowed: true };

  const monthlyAiReplies = await tickets.countDocuments({
    companyId: { $in: [companyObjId, companyObjId.toHexString()] },
    aiResolved: true,
    createdAt: { $gte: getMonthStartDate() },
  });

  if (monthlyAiReplies >= limits.aiReplies) {
    return {
      allowed: false,
      message: `Monthly AI reply limit (${limits.aiReplies}) reached for ${planName}.`,
    };
  }
  return { allowed: true };
}

async function checkStaffSeatLimit({ companies, users, companyId, role }) {
  if (!["manager", "agent"].includes(role)) return { allowed: true };

  const companyObjId =
    companyId instanceof ObjectId ? companyId : new ObjectId(companyId);
  const company = await companies.findOne({ _id: companyObjId });
  const { planName, limits } = getEffectiveLimits(company);

  const scope = {
    companyId: { $in: [companyObjId, companyObjId.toHexString()] },
  };

  if (role === "manager" && limits.managers !== null) {
    const activeManagers = await users.countDocuments({
      ...scope,
      role: "manager",
      status: "active",
      verifyIdAgent: { $ne: "pending" },
    });
    if (activeManagers >= limits.managers) {
      return {
        allowed: false,
        message: `Manager seat limit (${limits.managers}) reached on ${planName}. Upgrade plan to add more managers.`,
      };
    }
  }

  if (role === "agent" && limits.agents !== null) {
    const activeAgents = await users.countDocuments({
      ...scope,
      role: "agent",
      status: "active",
      verifyIdAgent: "approved",
    });
    if (activeAgents >= limits.agents) {
      return {
        allowed: false,
        message: `Agent seat limit (${limits.agents}) reached on ${planName}. Upgrade plan to add more agents.`,
      };
    }
  }

  return { allowed: true };
}

module.exports = {
  DEFAULT_LIMITS,
  getEffectiveLimits,
  checkTicketCreationLimit,
  checkAiReplyLimit,
  checkStaffSeatLimit,
};
