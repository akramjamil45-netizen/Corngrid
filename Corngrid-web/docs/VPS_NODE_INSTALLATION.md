# Sandbox node installation

Choose the guide matching the VPS operating system. These guides are separate.

- [Windows VPS](VPS_NODE_INSTALLATION_WINDOWS.md): native MT5, PowerShell and Scheduled Tasks.
- [Linux / Ubuntu VPS](VPS_NODE_INSTALLATION_LINUX.md): Node.js Linux, MT5 through Wine, Xvfb and systemd.

Windows remains the established hosting path. The Linux/Wine implementation must pass the documented demo-node acceptance checks before production hosting; Wine is not a native Linux MT5 binary or a VM isolation boundary.

Installation packages:

- Windows: CornGrid-Node-Agent.zip
- Linux x86-64: CornGrid-Node-Agent-Linux.tar.gz and its .sha256 file

Never reuse a node token across machines. Installing a node does not increase user licence or MT5 activation limits.
