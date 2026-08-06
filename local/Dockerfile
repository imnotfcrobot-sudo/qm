ARG BASE=qm-sandbox-base:dev
FROM ${BASE}

COPY aws/microvm-agent/agent.mjs /opt/microvm-agent/agent.mjs

RUN useradd --create-home --uid 10001 --shell /bin/bash agent \
  && mkdir -p /home/agent/workspace \
  && chown -R agent:agent /home/agent

ENV HOME=/home/agent
WORKDIR /home/agent
EXPOSE 8080
USER agent
CMD ["node", "/opt/microvm-agent/agent.mjs"]
