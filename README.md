# jeff

A small web page for controlling an Ecovacs Deebot robot: start, pause, stop,
return to dock, suction and water level, battery, consumables, and an
interactive map (clean selected rooms or send the robot to a point).

A Go server serves the page and runs a Node bridge (`bridge/`) that talks to the
robot through the [ecovacs-deebot](https://github.com/mrbungle64/ecovacs-deebot.js) library.

## Run

```bash
cp .env.example .env   # then fill it in
docker compose up -d --build
```

Open <http://localhost:3000>.

If Ecovacs asks to verify this app, it e-mails a code to the account address
and the page shows a form to enter it. Verification is tied to
`ECOVACS_CLIENT_DEVICE_ID`, so keep that value when moving the container.
