FROM node:22-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4870 DATA_DIR=/data
WORKDIR /app
# no npm dependencies: the server only uses Node's built-in modules (incl. node:sqlite)
COPY package.json ./
COPY bin ./bin
COPY src ./src
COPY public ./public
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 4870
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "bin/sprite-admin.js"]
