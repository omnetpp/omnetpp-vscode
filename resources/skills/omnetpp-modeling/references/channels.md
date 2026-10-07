# Channel Types and Properties

## Table of Contents
- [Built-in Channels](#built-in-channels)
- [Channel Properties](#channel-properties)
- [Custom Channels](#custom-channels)
- [Channel Usage](#channel-usage)
- [Wireless Channels](#wireless-channels)

## Built-in Channels

### ned.IdealChannel
Zero delay, infinite bandwidth, no errors.
```ned
a.out --> ned.IdealChannel --> b.in;
// Equivalent to:
a.out --> b.in;
```

### ned.DelayChannel
Propagation delay only, no bandwidth limit.
```ned
channel DelayChannel
{
    @class(cDelayChannel);
    bool disabled = default(false);
    double delay @unit(s) = default(0s);
}
```

### ned.DatarateChannel
Full-featured channel with delay, datarate, and error modeling.
```ned
channel DatarateChannel
{
    @class(cDatarateChannel);
    bool disabled = default(false);
    double delay @unit(s) = default(0s);
    double datarate @unit(bps) = default(0bps);  // 0 = infinite
    double ber = default(0);  // Bit error rate
    double per = default(0);  // Packet error rate
}
```

## Channel Properties

| Property | Type | Description |
|----------|------|-------------|
| `disabled` | bool | If true, channel discards all messages |
| `delay` | time | Propagation delay |
| `datarate` | bps | Transmission rate (determines duration) |
| `ber` | double | Bit error rate (0-1) |
| `per` | double | Packet error rate (0-1) |

### Transmission Duration
For `DatarateChannel`, transmission duration is calculated as:
```
duration = packet.getBitLength() / datarate
```

The message arrives at destination after `delay + duration`.

### Error Modeling
- **BER (Bit Error Rate)**: Probability of each bit being corrupted
  - Packet marked as corrupted if any bit has error
  - `P(error) = 1 - (1-ber)^bitLength`
  
- **PER (Packet Error Rate)**: Probability of entire packet being corrupted
  - Applied independently of BER

Check in receiver:
```cpp
if (pkt->hasBitError()) {
    // Handle corrupted packet
    delete pkt;
    return;
}
```

## Custom Channels

### Extending DatarateChannel
```ned
channel Ethernet100M extends ned.DatarateChannel
{
    datarate = 100Mbps;
    delay = 0.5us;  // ~100m cable
}

channel WAN extends ned.DatarateChannel
{
    datarate = default(10Mbps);
    delay = default(uniform(10ms, 100ms));
    per = default(0.001);
}
```

### Parameterized Channel
```ned
channel ConfigurableLink extends ned.DatarateChannel
{
    parameters:
        double distance @unit(m);
        delay = distance / 200000km * 1s;  // ~speed of light in fiber
        datarate = default(1Gbps);
}
```

### Channel with Statistics
```ned
channel MonitoredChannel extends ned.DatarateChannel
{
    @signal[messageSent](type=cMessage);
    @signal[messageDiscarded](type=cMessage);
    @statistic[throughput](source=throughput(messageSent); record=vector);
    @statistic[utilization](source=timeavg(busy); record=last);
}
```

## Channel Usage

### In Connections
```ned
connections:
    // Use channel type
    a.out --> Ethernet100M --> b.in;
    
    // Bidirectional
    a.port <--> WAN <--> b.port;
    
    // Inline parameters
    a.out --> { delay = 10ms; datarate = 1Gbps; } --> b.in;
    
    // Override channel parameters
    a.out --> Ethernet100M { delay = 1us; } --> b.in;
```

### Local Channel Types
```ned
network MyNetwork
{
    types:
        channel C extends ned.DatarateChannel {
            delay = uniform(1ms, 10ms);
            datarate = 100Mbps;
        }
    connections:
        node[0].port++ <--> C <--> node[1].port++;
}
```

### Accessing Channel from C++
```cpp
void MyModule::initialize()
{
    cChannel *channel = gate("out")->getChannel();
    if (channel) {
        double datarate = channel->par("datarate").doubleValue();
        simtime_t delay = channel->par("delay").doubleValue();
    }
}

// Get transmission finish time
cChannel *ch = gate("out")->getTransmissionChannel();
simtime_t finishTime = ch->getTransmissionFinishTime();

// Check if channel is busy
if (ch->isBusy()) {
    // Wait for channel to become free
    scheduleAt(ch->getTransmissionFinishTime(), waitMsg);
}
```

## Wireless Channels

For wireless simulation, use `sendDirect()` instead of channels:

```cpp
// In sender
void WirelessHost::transmit(cPacket *pkt)
{
    simtime_t propagationDelay = distance / speedOfLight;
    simtime_t duration = pkt->getBitLength() / txRate;
    
    // Send directly to receiver's gate
    sendDirect(pkt, propagationDelay, duration, receiver->gate("radioIn"));
}
```

### Wireless Channel Model Pattern
```ned
simple WirelessChannel
{
    parameters:
        double propagationSpeed @unit(mps) = default(299792458mps);
        double pathLossExponent = default(2.0);
        double noisePower @unit(dBm) = default(-110dBm);
    gates:
        input in[];
}
```

```cpp
// Calculate received power
double WirelessChannel::calculateReceivedPower(double txPower, double distance)
{
    // Free space path loss
    double lambda = speedOfLight / frequency;
    double pathLoss = pow(4 * M_PI * distance / lambda, pathLossExponent);
    return txPower / pathLoss;
}

// Determine if packet is received correctly
bool WirelessChannel::isReceived(double rxPower, double noisePower)
{
    double snr = rxPower / noisePower;
    double ber = calculateBER(snr, modulation);
    double per = 1 - pow(1 - ber, packetBits);
    return uniform(0, 1) > per;
}
```

## Display String for Channels

```ned
channel RedLink extends ned.DatarateChannel
{
    @display("ls=red,2");  // Red line, width 2
}

channel DashedLink extends ned.DatarateChannel
{
    @display("ls=blue,1,d");  // Blue dashed line
}
```

Line style options:
- Color: `ls=color` (red, blue, #RRGGBB)
- Width: `ls=color,width`
- Style: `ls=color,width,style` (s=solid, d=dashed, da=dash-dot)
