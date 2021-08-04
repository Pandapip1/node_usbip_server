
'use strict';

const ASCII_ENCODED_ZERO = Buffer.from([0]).toString('ASCII');

const net = require('net');
const { EventEmitter } = require('events');
const util = require('util');

const lib = require('./lib.js');
//const
//    {
//        OP_REP_DEVLIST, OP_REQ_DEVLIST,
//        OP_REP_IMPORT, OP_REQ_IMPORT,
//        USBIP_CMD_SUBMIT, USBIP_CMD_UNLINK,
//        USBIP_RET_SUBMIT, USBIP_RET_UNLINK,
//    } = lib;

/**
 * @typedef UsbIpServerSimConfig
 * @property {string} version
 * @property {net.ServerOpts} [tcpOptions]
 */

class UsbIpServerSim extends EventEmitter {
    /**
     * 
     * @param {UsbIpServerSimConfig} config
     */
    constructor(config) {
        config = config || {};
        config.tcpOptions = config.tcpOptions || { allowHalfOpen: false, pauseOnConnect: false, };

        try {
            this._server = new UsbIpServer(config.tcpOptions);
            this._protocolLayer = new UsbIpProtocolLayer(this._server, config.version);

            this._protocolLayer.on('error', error => this.emit('protocolError', error));
        } catch (error) {
            throw new Error(`Failed to initialize net.Server object in UsbIpServerSim constructor. Reason = ${error}`);
        }
    }

    /**
     * 
     * @param {SimulatedUsbDevice} device
     */
    exportDevice(device) {
        let emptyIndexes = this._server.getEmptyIndexes();
        if (emptyIndexes.length < 1) {
            this._server.devices.push(device);
        } else {
            this._server.devices[emptyIndexes[0]] = device;
        }

        return device;
    }

    /**
     * 
     * @param {number | SimulatedUsbDevice} deviceOrDeviceIndex
     * @param {SimulatedUsbDevice}
     */
    removeDevice(deviceOrDeviceIndex) {
        let devices = this._server.devices;
        if (isNaN(deviceOrDeviceIndex)) {
            let index = devices.findIndex(deviceOrDeviceIndex);

            if (index == -1) {
                return null;
            } else {
                return this.removeDevice(index);
            }
        } else if (deviceOrDeviceIndex >= devices.length || deviceOrDeviceIndex < 0) {
            throw new Error(`Index '${deviceOrDeviceIndex}' out of range; numDevices = ${devices.length}`);
        } else {
            let removedDevice = devices[deviceOrDeviceIndex];
            devices[deviceOrDeviceIndex] = null;

            this._protocolLayer.notifyRemoved(removedDevice);
        }
    }

    *removeAllDevices() {
        for (let removedDevice of this._server.devices.splice(0, Infinity)) {
            this._protocolLayer.notifyRemoved(removedDevice);
            yield removedDevice;
        }
    }

    /**
     *
     * @param {number} port
     * @param {string} address
     */
    listen(port, address) {
        this._server.listen(port, address);
        return this;
    }
}

class UsbIpProtocolLayer extends EventEmitter {
    /**
     * @param {UsbIpServer} serverToControl
     * @param {string} [version]
     */
    constructor(serverToControl, version) {
        this.versionString = version || '1.1.1';
        this.encodedVersionNumber = 0;
        if (this.versionString) {
            let versionSplit = this.versionString.split('.');
            if (versionSplit.length > 4) {
                throw new Error(`Bad configuration: 'version' may have a maximum of 4 version numbers`);
            }
            for (let versionNibble of versionSplit.reverse()) {
                versionNibble = Number(versionNibble);
                if (isNaN(versionNibble)) {
                    throw new Error(`Bad configuration: 'version' is not formatted correctly (must be numbers seperated by '.' character)`);
                } else if (versionNibble < 0 || versionNibble > 0xf) {
                    throw new Error(`Bad configuration: 'version' numbers must each fit in a nibble; number '${versionNibble}' is too large/small`);
                } else {
                    this.encodedVersionNumber <<= 4;
                    this.encodedVersionNumber += versionNibble;
                }
            }
        }

        this.server = serverToControl;
        this.server.on('connection', socket => {
            socket.on('data', data => {
                this.handle(data, socket)
            });
            socket.on('close', () => socket.destroy());
        });
    }

    /**
     * 
     * @param {Buffer} incomingData
     * @param {net.Socket} socket
     */
    handle(incomingData, socket) {
        if (incomingData.length < 4) {
            this.emit('error', new Error(`Commands must be at least 4 bytes in length; called handle(${util.inspect(incomingData)})`));
        } else {
            let incomingVersion = incomingData.readUInt16BE();

            // if no version was given by config, simply mirror the client's version
            let outgoingVersion = this.encodedVersionNumber || incomingVersion;

            let incomingCommand = incomingData.readUInt16BE(2);
            let cmdHandler = this[incomingCommand];

            if (!cmdHandler) {
                this.emit('error', new Error(`Unrecognized command (0x${incomingCommand.toString(16)})`));
            } else {
                try {
                    cmdHandler(socket, outgoingVersion, incomingData);
                } catch (err) {
                    this.emit('error', new Error(`Unable to process incoming packet ${util.inspect(incomingData)}. Reason = ${err}`));
                }
            }
        }
    }

    /**
     * 
     * @param {SimulatedUsbDevice} device
     */
    notifyRemoved(device) {
        // TODO: Does this cleanly inform the OS that the device was unplugged?
        if (device._attachedSocket) {
            device._attachedSocket.end(() => device._attachedSocket.destroy());
        }
    }

    /**
     * 
     * @param {net.Socket} socket
     * @param {Buffer} data
     */
    notifyAndWriteData(socket, data) {
        return socket.write(data, err => {
            this.emit('write', socket, data, err);
        });
    }

    /**
     * 
     * @param {net.Socket} socket The socket from which this command came
     * @param {number} serverVersion
     * @param {Buffer} packet Incoming command data
     */
    [lib.commands.OP_REQ_DEVLIST](socket, serverVersion, packet) {
        if (packet.length != 8) {
            throw new Error('Length of OP_REQ_DEVLIST packet must be 8');
        } else {
            this.notifyAndWriteData(socket, this.constructDeviceListResponse(serverVersion, [...this.server.enumerateDevices()]));
        }
    }

    /**
     *
     * @param {net.Socket} socket The socket from which this command came
     * @param {number} serverVersion
     * @param {Buffer} packet Incoming command data
     */
    [lib.commands.OP_REQ_IMPORT](socket, serverVersion, packet) {
        if (packet.length != 40) {
            throw new Error('Length of OP_REQ_IMPORT packet must be 40');
        } else {
            let requestedBusId = this.readBusId(packet.slice(8, 40));

            let matchingDevice = this.server.getDeviceByBusId(requestedBusId);

            if (matchingDevice && !matchingDevice._attachedSocket) {
                matchingDevice._attachedSocket = socket;

                this.notifyAndWriteData(socket, this.constructImportResponse(serverVersion, matchingDevice, true));
            } else {
                // TODO: device is already attached; send error response
                this.notifyAndWriteData(socket, this.constructImportResponse(serverVersion, null, false));
            }
        }
    }

    /**
     *
     * @param {net.Socket} socket The socket from which this command came
     * @param {number} serverVersion
     * @param {Buffer} packet Incoming command data
     */
    [lib.commands.USBIP_CMD_SUBMIT](socket, serverVersion, packet) {
        // TODO: implement
        throw new Error('USBIP_CMD_SUBMIT Not Implemented');
    }

    /**
     *
     * @param {net.Socket} socket The socket from which this command came
     * @param {number} serverVersion
     * @param {Buffer} packet Incoming command data
     */
    [lib.commands.USBIP_CMD_UNLINK](socket, serverVersion, packet) {
        // TODO: implement
        throw new Error('USBIP_CMD_UNLINK Not Implemented');
    }

    /**
     * 
     * @param {number} uint16
     */
    constructUInt16BE(uint16) {
        let buf = Buffer.allocUnsafe(2);
        buf.writeUInt16BE(uint16);
        return buf;
    }

    /**
     * 
     * @param {number} uint32
     */
    constructUInt32BE(uint32) {
        let buf = Buffer.allocUnsafe(4);
        buf.writeUInt32BE(uint32);
        return buf;
    }

    /**
     * 
     * @param {string} str
     */
    constructPaddedStringBuffer(str, desiredLength) {
        if (str.length > desiredLength) {
            throw new Error(`Cannot fit str ${str} into ${desiredLength} bytes`);
        } else {
            return Buffer.from(str.padEnd(desiredLength, ASCII_ENCODED_ZERO));
        }
    }

    /**
     * 
     * @param {Buffer} buf
     */
    readPaddedStringBuffer(buf) {
        for (let i = buf.length - 1; i > -1; i--) {
            if (buf[i]) {
                return buf.toString('ASCII', 0, i + 1);
            }
        }

        // if we exit the above loop, buffer must be all zeros
        return '';
    }

    /**
     * 
     * @param {number} serverVersion
     * @param {SimulatedUsbDevice[]} deviceList
     */
    constructDeviceListResponse(serverVersion, deviceList) {
        let responseBytes = this.constructHeaderBytes(serverVersion, lib.commands.OP_REP_DEVLIST);

        for (let device of deviceList) {
            responseBytes = Buffer.concat(
                [
                    responseBytes,
                    this.constructDeviceDescription(device, true),
                ]
            );
        }

        return responseBytes;
    }

    /**
     * 
     * @param {number} serverVersion
     * @param {SimulatedUsbDevice} deviceToImport
     * @param {boolean} [importSucceeded]
     */
    constructImportResponse(serverVersion, deviceToImport, importSucceeded) {
        importSucceeded = deviceToImport && importSucceeded;
        let responseBytes = this.constructHeaderBytes(serverVersion, lib.commands.OP_REP_IMPORT, importSucceeded ? 0 : 1);

        if (importSucceeded) {
            responseBytes = Buffer.concat(
                [
                    responseBytes,
                    this.constructDeviceDescription(deviceToImport, false),
                ]
            );
        }

        return responseBytes;
    }

    /**
     * 
     * @param {number} serverVersion
     * @param {number} replyCode
     * @param {number} [status]
     */
    constructHeaderBytes(serverVersion, replyCode, status) {
        Buffer.concat([
            this.constructVersionBytes(serverVersion),
            this.constructReplyCodeBytes(replyCode),
            this.constructStatusBytes(status || 0),
        ]);
    }

    /**
     * 
     * @param {number} version
     */
    constructVersionBytes(version) {
        return this.constructUInt16BE(version);
    }

    /**
     * 
     * @param {number} replyCode
     */
    constructReplyCodeBytes(replyCode) {
        return this.constructUInt16BE(replyCode);
    }

    /**
     * 
     * @param {number} status
     */
    constructStatusBytes(status) {
        return this.constructUInt32BE(status);
    }

    /**
     * 
     * @param {SimulatedUsbDevice} device
     * @param {boolean} [includeInterfaceDescriptions] Default: false
     */
    constructDeviceDescription(device, includeInterfaceDescriptions) {
        let config = device.config;
        let deviceDescriptionBytes = Buffer.concat(
            [
                this.constructPathBytes(config.path),
                this.constructBusId(config.busid),
                this.constructBusNum(config.busnum),
                this.constructDevNum(config.devnum),
                this.constructSpeed(config.speed),
                this.constructVendorId(config.idVendor),
                this.constructProductId(config.idProduct),
                this.constructDeviceBcd(config.bcdDevice),

                // single-byte entries (not really worth helper-methods)
                Buffer.from(
                    [
                        config.bDeviceClass,
                        config.bDeviceSubClass,
                        config.bDeviceProtocol,
                        config.bConfigurationValue,
                        config.bNumConfigurations,
                        config.interfaces.length
                    ]
                ),
            ]
        );

        if (includeInterfaceDescriptions) {
            for (let interface of config.interfaces) {
                deviceDescriptionBytes = Buffer.concat(
                    [
                        deviceDescriptionBytes,
                        this.constructDeviceInterfaceDescription(interface),
                    ]
                );
            }
        }

        return deviceDescriptionBytes;
    }

    /**
     * 
     * @param {SimulatedUsbDeviceInterface} interface
     */
    constructDeviceInterfaceDescription(interface) {
        return Buffer.concat(
            [
                interface.bInterfaceClass,
                interface.bInterfaceSubClass,
                interface.bInterfaceProtocol,
                0,  // padding byte for alignment
            ]
        );
    }

    /**
     * 
     * @param {string} path
     */
    constructPathBytes(path) {
        return this.constructPaddedStringBuffer(path, 256);
    }

    /**
     *
     * @param {string} path
     */
    constructBusId(busId) {
        return this.constructPaddedStringBuffer(busId, 32);
    }

    /**
     * 
     * @param {Buffer} busId
     */
    readBusId(busId) {
        return this.readPaddedStringBuffer(busId);
    }

    /**
     * 
     * @param {number} busNum
     */
    constructBusNum(busNum) {
        return this.constructUInt32BE(busNum);
    }

    /**
     * 
     * @param {number} devNum
     */
    constructDevNum(devNum) {
        return this.constructUInt32BE(devNum);
    }

    /**
     * 
     * @param {number} speed
     */
    constructSpeed(speed) {
        return this.constructUInt32BE(speed);
    }

    /**
     * 
     * @param {number} idVendor
     */
    constructVendorId(idVendor) {
        return this.constructUInt16BE(idVendor);
    }

    /**
     * 
     * @param {number} idProduct
     */
    constructProductId(idProduct) {
        return this.constructUInt16BE(idProduct);
    }

    /**
     * 
     * @param {number} bcdDevice
     */
    constructDeviceBcd(bcdDevice) {
        return this.constructUInt16BE(bcdDevice);
    }
}

class UsbIpServer extends net.Server {
    /**
     * 
     * @param {net.ServerOpts} options
     */
    constructor(options) {
        super(options);

        /** @type {SimulatedUsbDevice[]} */
        this.devices = [];
    }

    *enumerateDevices() {
        for (let device of this.devices) {
            if (device) {
                yield device;
            }
        }
    }

    *getEmptyIndexes() {
        for (let deviceIndex in this.devices) {
            if (!this.devices[deviceIndex]) {
                yield Number(deviceIndex);
            }
        }
    }

    /**
     * 
     * @param {string} busIdQuery
     */
    getDeviceByBusId(busIdQuery) {
        for (let device of this.enumerateDevices()) {
            if (device.config.busid == busIdQuery) {
                return device;
            }
        }

        return null;
    }
}

/**
 * @typedef SimulatedUsbDeviceConfig
 * @property {string} path
 * @property {string} busid
 * @property {number} busnum
 * @property {number} devnum
 * @property {number} speed
 * @property {number} idVendor
 * @property {number} idProduct
 * @property {number} bcdDevice
 * @property {number} bDeviceClass
 * @property {number} bDeviceSubClass
 * @property {number} bDeviceProtocol
 * @property {number} bConfigurationValue
 * @property {number} bNumConfigurations
 * @property {SimulatedUsbDeviceInterface[]} interfaces 
 */

/**
 * @typedef SimulatedUsbDeviceInterface
 * @property {string} bInterfaceClass
 * @property {string} bInterfaceSubClass
 * @property {string} bInterfaceProtocol
 */

class SimulatedUsbDevice extends EventEmitter {
    /**
     * 
     * @param {SimulatedUsbDeviceConfig} config
     */
    constructor(config) {
        this.config = config;

        /** @type {net.Socket} */
        this._attachedSocket = null;
    }
}

module.exports.UsbIpServerSim = UsbIpServerSim;
module.exports.lib = lib;
