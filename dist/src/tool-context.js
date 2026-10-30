/** The freshest config the host offers for this tool call. */
export function runtimeConfig(ctx) {
    return ctx.getRuntimeConfig?.() ?? ctx.runtimeConfig ?? ctx.config;
}
export function getContext(ctx) {
    const cfg = runtimeConfig(ctx);
    if (!cfg || !ctx.agentId)
        return undefined;
    return {
        cfg,
        agentId: ctx.agentId,
        requestContext: {
            sessionKey: ctx.sessionKey,
            sessionId: ctx.sessionId,
            messageChannel: ctx.messageChannel,
            agentAccountId: ctx.agentAccountId,
            nativeChannelId: ctx.nativeChannelId,
            deliveryContext: ctx.deliveryContext,
        },
    };
}
