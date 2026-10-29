# Builds the Go web server
FROM golang:1.24-bookworm AS server
WORKDIR /src
COPY go.mod main.go ./
COPY static ./static
RUN CGO_ENABLED=0 go build -o /jeff .

FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY bridge ./bridge
COPY --from=server /jeff /usr/local/bin/jeff
USER node
EXPOSE 3000
CMD ["jeff"]
