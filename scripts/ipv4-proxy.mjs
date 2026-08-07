// 贾维斯终端 · IPv4 强制代理（网络 IPv6 异常时让 git 走 HTTPS 推送）
// 用法：node scripts/ipv4-proxy.mjs   （监听 127.0.0.1:3128）
import net from "node:net";
import http from "node:http";
import dns from "node:dns";

const PORT = Number(process.env.JARVIS_PROXY_PORT || 3128);

const server = http.createServer((req, res) => {
  res.writeHead(405, { "Content-Type": "text/plain" });
  res.end("IPv4 proxy: only CONNECT supported");
});

server.on("connect", (req, clientSocket, head) => {
  const [host, portRaw] = req.url.split(":");
  const port = Number(portRaw) || 443;
  dns.lookup(host, { family: 4 }, (err, addr) => {
    if (err || !addr) {
      clientSocket.destroy();
      return;
    }
    const upstream = net.connect(port, addr, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length) upstream.write(head);
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`IPv4 proxy ready at 127.0.0.1:${PORT}`);
});
