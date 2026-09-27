// ============================================================
//  YC_CAR_DEMO TurboWarp / Scratch 3 Extension
//  Author: Antigravity
//  Description: Controls the YC_CAR_DEMO BLE RC Car via Web Bluetooth
// ============================================================

(function (Scratch) {
    'use strict';

    if (!Scratch.extensions.unsandboxed) {
        throw new Error('The YC Car extension must run unsandboxed to access Web Bluetooth.');
    }

    const BLE_CONFIG = {
        defaultName: 'YC_CAR_DEMO',
        serviceUuid: 0xfff0,
        writeUuid: 0xfff2,
        notifyUuid: 0xfff1,
        modeByte: 0x01,
        intervalMs: 80
    };

    // Verified YC_CAR_DEMO bitmask protocol (0x40 base with play-bit)
    const CONTROL_BYTES = {
        FORWARD: 0x41,
        REVERSE: 0x42,
        LEFT: 0x44,
        RIGHT: 0x48,
        FORWARD_LEFT: 0x45,
        FORWARD_RIGHT: 0x49,
        REVERSE_LEFT: 0x46,
        REVERSE_RIGHT: 0x4A,
        STOP: 0x40
    };

    class YCCarExtension {
        constructor() {
            this.device = null;
            this.server = null;
            this.writeCharacteristic = null;
            this.connected = false;
            this.activeControlByte = CONTROL_BYTES.STOP;
            this.activeSpeed = 100;
            this.sendInterval = null;
            this.isWriting = false;
            this.lastTxHex = 'None';
            this.lastRxHex = 'None';
        }

        getInfo() {
            return {
                id: 'yccardemo',
                name: 'YC RC Car',
                color1: '#00e599',
                color2: '#00c784',
                color3: '#009966',
                menuIconURI: '',
                blockIconURI: '',
                blocks: [
                    // --- CONNECTION ---
                    {
                        opcode: 'connectCar',
                        blockType: Scratch.BlockType.COMMAND,
                        text: 'connect to car [NAME]',
                        arguments: {
                            NAME: {
                                type: Scratch.ArgumentType.STRING,
                                defaultValue: 'YC_CAR_DEMO'
                            }
                        }
                    },
                    {
                        opcode: 'disconnectCar',
                        blockType: Scratch.BlockType.COMMAND,
                        text: 'disconnect car'
                    },
                    {
                        opcode: 'isConnected',
                        blockType: Scratch.BlockType.BOOLEAN,
                        text: 'is car connected?'
                    },

                    '---',

                    // --- DIRECT DRIVING (CONTINUOUS) ---
                    {
                        opcode: 'driveDirection',
                        blockType: Scratch.BlockType.COMMAND,
                        text: 'drive [DIR] at [SPEED] %',
                        arguments: {
                            DIR: {
                                type: Scratch.ArgumentType.STRING,
                                menu: 'directionMenu',
                                defaultValue: 'FORWARD'
                            },
                            SPEED: {
                                type: Scratch.ArgumentType.NUMBER,
                                defaultValue: 100
                            }
                        }
                    },
                    {
                        opcode: 'stopCar',
                        blockType: Scratch.BlockType.COMMAND,
                        text: 'stop car'
                    },

                    '---',

                    // --- TIMED DRIVING (BLOCKING / WAIT) ---
                    {
                        opcode: 'driveForSeconds',
                        blockType: Scratch.BlockType.COMMAND,
                        text: 'drive [DIR] for [SECS] secs at [SPEED] %',
                        arguments: {
                            DIR: {
                                type: Scratch.ArgumentType.STRING,
                                menu: 'directionMenu',
                                defaultValue: 'FORWARD'
                            },
                            SECS: {
                                type: Scratch.ArgumentType.NUMBER,
                                defaultValue: 1
                            },
                            SPEED: {
                                type: Scratch.ArgumentType.NUMBER,
                                defaultValue: 100
                            }
                        }
                    },

                    '---',

                    // --- ADVANCED / TELEMETRY ---
                    {
                        opcode: 'sendRawHex',
                        blockType: Scratch.BlockType.COMMAND,
                        text: 'send raw control byte [HEX] speed [SPEED] %',
                        arguments: {
                            HEX: {
                                type: Scratch.ArgumentType.STRING,
                                defaultValue: '41'
                            },
                            SPEED: {
                                type: Scratch.ArgumentType.NUMBER,
                                defaultValue: 100
                            }
                        }
                    },
                    {
                        opcode: 'getLastTx',
                        blockType: Scratch.BlockType.REPORTER,
                        text: 'last packet sent'
                    },
                    {
                        opcode: 'getLastRx',
                        blockType: Scratch.BlockType.REPORTER,
                        text: 'last packet received'
                    }
                ],
                menus: {
                    directionMenu: {
                        acceptReporters: true,
                        items: [
                            { text: 'forward ▲', value: 'FORWARD' },
                            { text: 'backward ▼', value: 'REVERSE' },
                            { text: 'steer left ◀', value: 'LEFT' },
                            { text: 'steer right ▶', value: 'RIGHT' },
                            { text: 'forward left ↖', value: 'FORWARD_LEFT' },
                            { text: 'forward right ↗', value: 'FORWARD_RIGHT' },
                            { text: 'backward left ↙', value: 'REVERSE_LEFT' },
                            { text: 'backward right ↘', value: 'REVERSE_RIGHT' }
                        ]
                    }
                }
            };
        }

        // ============================================================
        //  PACKET BUILDER & TRANSMISSION
        // ============================================================
        buildPacket(controlByte, speed) {
            const spdClamped = Math.max(0, Math.min(100, Math.round(speed)));
            return new Uint8Array([
                0xAA,
                0x00,
                0x02,
                0x00,
                0x00,
                0x00,
                0x00,
                controlByte & 0xFF,
                spdClamped & 0xFF,
                BLE_CONFIG.modeByte & 0xFF
            ]);
        }

        async sendPacket(controlByte, speed) {
            if (!this.connected || !this.writeCharacteristic) return;
            if (this.isWriting) return;
            this.isWriting = true;

            const packet = this.buildPacket(controlByte, speed);
            const hex = Array.from(packet).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');

            try {
                if (this.writeCharacteristic.properties && this.writeCharacteristic.properties.writeWithoutResponse) {
                    await this.writeCharacteristic.writeValueWithoutResponse(packet);
                } else if (this.writeCharacteristic.writeValueWithoutResponse) {
                    await this.writeCharacteristic.writeValueWithoutResponse(packet);
                } else {
                    await this.writeCharacteristic.writeValueWithResponse(packet);
                }
                this.lastTxHex = hex;
            } catch (err) {
                console.error('[YC Car] Write failed:', err);
                this.stopSending();
            } finally {
                this.isWriting = false;
            }
        }

        startSending(controlByte, speed) {
            this.activeControlByte = controlByte;
            this.activeSpeed = speed;

            // Send immediately
            this.sendPacket(this.activeControlByte, this.activeSpeed);

            // Repeat transmission interval
            if (!this.sendInterval) {
                this.sendInterval = setInterval(() => {
                    this.sendPacket(this.activeControlByte, this.activeSpeed);
                }, BLE_CONFIG.intervalMs);
            }
        }

        stopSending() {
            if (this.sendInterval) {
                clearInterval(this.sendInterval);
                this.sendInterval = null;
            }
            this.activeControlByte = CONTROL_BYTES.STOP;

            if (this.connected && this.writeCharacteristic) {
                this.sendPacket(CONTROL_BYTES.STOP, 0);
            }
        }

        // ============================================================
        //  BLOCK IMPLEMENTATIONS
        // ============================================================
        async connectCar(args) {
            const targetName = (args.NAME || BLE_CONFIG.defaultName).trim();
            if (this.connected) return;

            try {
                this.device = await navigator.bluetooth.requestDevice({
                    filters: [{ name: targetName }],
                    optionalServices: [BLE_CONFIG.serviceUuid]
                });

                this.device.addEventListener('gattserverdisconnected', () => {
                    this.connected = false;
                    this.stopSending();
                    this.writeCharacteristic = null;
                    this.server = null;
                });

                this.server = await this.device.gatt.connect();
                const service = await this.server.getPrimaryService(BLE_CONFIG.serviceUuid);
                this.writeCharacteristic = await service.getCharacteristic(BLE_CONFIG.writeUuid);

                // Optional FFF1 notifications
                try {
                    const notifyChar = await service.getCharacteristic(BLE_CONFIG.notifyUuid);
                    await notifyChar.startNotifications();
                    notifyChar.addEventListener('characteristicvaluechanged', (e) => {
                        const val = e.target.value;
                        const bytes = [];
                        for (let i = 0; i < val.byteLength; i++) {
                            bytes.push(val.getUint8(i).toString(16).toUpperCase().padStart(2, '0'));
                        }
                        this.lastRxHex = bytes.join(' ');
                    });
                } catch (e) {}

                this.connected = true;
                // Prime car with a stop frame
                this.sendPacket(CONTROL_BYTES.STOP, 0);
            } catch (err) {
                console.error('[YC Car] Connection error:', err);
                this.connected = false;
            }
        }

        disconnectCar() {
            this.stopSending();
            if (this.device && this.device.gatt.connected) {
                this.device.gatt.disconnect();
            }
            this.connected = false;
            this.writeCharacteristic = null;
            this.server = null;
        }

        isConnected() {
            return this.connected;
        }

        driveDirection(args) {
            const dir = String(args.DIR || 'FORWARD').toUpperCase();
            const speed = Number(args.SPEED) || 100;
            const byte = CONTROL_BYTES[dir] || CONTROL_BYTES.FORWARD;
            this.startSending(byte, speed);
        }

        stopCar() {
            this.stopSending();
        }

        async driveForSeconds(args) {
            const dir = String(args.DIR || 'FORWARD').toUpperCase();
            const speed = Number(args.SPEED) || 100;
            const seconds = Math.max(0.05, Number(args.SECS) || 1);
            const byte = CONTROL_BYTES[dir] || CONTROL_BYTES.FORWARD;

            this.startSending(byte, speed);

            await new Promise((resolve) => setTimeout(resolve, seconds * 1000));

            this.stopSending();
        }

        sendRawHex(args) {
            const hexStr = String(args.HEX || '41').trim();
            const byte = parseInt(hexStr, 16);
            const speed = Number(args.SPEED) || 100;
            if (!isNaN(byte)) {
                this.startSending(byte, speed);
            }
        }

        getLastTx() {
            return this.lastTxHex;
        }

        getLastRx() {
            return this.lastRxHex;
        }
    }

    Scratch.extensions.register(new YCCarExtension());
})(Scratch);
