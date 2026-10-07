# Statistics and Signals Guide

## Table of Contents
- [Signals Overview](#signals-overview)
- [Declaring Signals](#declaring-signals)
- [Emitting Signals](#emitting-signals)
- [Statistics Declaration](#statistics-declaration)
- [Recording Modes](#recording-modes)
- [Result Filters](#result-filters)
- [Configuration](#configuration)
- [Accessing Results](#accessing-results)

## Signals Overview

Signals are the mechanism for collecting statistics in OMNeT++:
1. **Declare** signal in NED
2. **Register** signal in C++ `initialize()`
3. **Emit** values during simulation
4. **Record** via statistics declaration

## Declaring Signals

### In NED File
```ned
simple Queue
{
    parameters:
        @signal[arrived](type=cMessage);
        @signal[dropped](type=long);
        @signal[queueLength](type=long);
        @signal[queueingTime](type=simtime_t);
        @signal[busy](type=bool);
}
```

### Signal Types
- `long` - Integer values
- `unsigned long` - Unsigned integers
- `double` - Floating point
- `simtime_t` - Simulation time
- `bool` - Boolean
- `cMessage`, `cPacket` - Message objects
- `cObject` - Any object

## Emitting Signals

### In C++ Code
```cpp
void Queue::initialize()
{
    // Register signals
    arrivedSignal = registerSignal("arrived");
    droppedSignal = registerSignal("dropped");
    queueLengthSignal = registerSignal("queueLength");
    queueingTimeSignal = registerSignal("queueingTime");
    busySignal = registerSignal("busy");
    
    // Emit initial values
    emit(queueLengthSignal, 0);
    emit(busySignal, false);
}

void Queue::handleMessage(cMessage *msg)
{
    emit(arrivedSignal, msg);  // Emit object
    
    if (queue.isFull()) {
        emit(droppedSignal, 1);
        delete msg;
        return;
    }
    
    queue.insert(msg);
    emit(queueLengthSignal, queue.getLength());
    
    // When dequeuing
    simtime_t waitTime = simTime() - msg->getTimestamp();
    emit(queueingTimeSignal, waitTime);
}
```

## Statistics Declaration

### Basic Syntax
```ned
@statistic[name](
    source=signalName;
    title="Human readable title";
    unit=unitName;
    record=modes;
    interpolationmode=mode
);
```

### Examples
```ned
// Simple: record signal directly
@statistic[queueLength](source=queueLength; record=vector,timeavg,max);

// With title and unit
@statistic[throughput](
    source=packetBytes;
    title="Throughput";
    unit=byte;
    record=sum,vector
);

// With filter chain
@statistic[endToEndDelay](
    source=mean(messageAge(arrived));
    title="End-to-end delay";
    unit=s;
    record=histogram,vector
);

// Enum for state tracking
@statistic[radioState](
    source=state;
    title="Radio state";
    enum="IDLE=0,TRANSMIT=1,RECEIVE=2";
    record=vector
);
```

## Recording Modes

| Mode | Description | Output |
|------|-------------|--------|
| `count` | Number of values | Scalar |
| `sum` | Sum of values | Scalar |
| `mean` | Arithmetic mean | Scalar |
| `min` | Minimum value | Scalar |
| `max` | Maximum value | Scalar |
| `timeavg` | Time-weighted average | Scalar |
| `last` | Last value | Scalar |
| `stats` | count, sum, mean, min, max, stddev | Scalar |
| `vector` | All values with timestamps | Vector |
| `histogram` | Distribution histogram | Histogram |

### Optional Recording
```ned
// ? makes recording optional (off by default)
@statistic[detailed](source=data; record=vector?,histogram?);
```

Enable in omnetpp.ini:
```ini
**.detailed.result-recording-modes = +vector,+histogram
```

## Result Filters

Filters transform signal values before recording.

### Value Filters
```ned
// Extract packet properties
@statistic[rcvdBytes](source=sum(packetBytes(arrived)); record=last);
@statistic[rcvdBits](source=sum(packetBits(arrived)); record=last);

// Math operations
@statistic[utilization](source=timeavg(busy); record=last);
@statistic[avgDelay](source=mean(queueingTime); record=last);

// Message age (time since creation)
@statistic[e2eDelay](source=messageAge(arrived); record=vector,mean);
```

### Filter Functions
| Filter | Description |
|--------|-------------|
| `count(signal)` | Count emissions |
| `sum(signal)` | Running sum |
| `mean(signal)` | Running mean |
| `min(signal)` | Running minimum |
| `max(signal)` | Running maximum |
| `timeavg(signal)` | Time-weighted average |
| `packetBytes(signal)` | Extract byte length from packet |
| `packetBits(signal)` | Extract bit length from packet |
| `messageAge(signal)` | Time since message creation |
| `throughput(signal)` | Bytes per second |

### Chaining Filters
```ned
@statistic[avgPacketSize](
    source=mean(packetBytes(arrived));
    record=last
);

@statistic[throughput](
    source=throughput(packetBits(arrived));
    unit=bps;
    record=vector,mean
);
```

## Interpolation Modes

Affects how vector data is interpreted for analysis:

| Mode | Use Case |
|------|----------|
| `none` | Discrete events (packet arrivals) |
| `sample-hold` | Step function (queue length, state) |
| `backward-sample-hold` | Value valid until next sample |
| `linear` | Linear interpolation between points |

```ned
@statistic[queueLength](
    source=queueLength;
    record=vector,timeavg;
    interpolationmode=sample-hold
);

@statistic[packetDelay](
    source=delay;
    record=vector,mean;
    interpolationmode=none
);
```

## Configuration

### In omnetpp.ini
```ini
[General]
# Global settings
**.result-recording-modes = default
**.scalar-recording = true
**.vector-recording = true

# Disable specific statistics
**.queue*.queueLength.scalar-recording = false

# Enable optional recording modes
**.hopCount.result-recording-modes = +histogram

# Disable vector, keep scalars
**.result-recording-modes = -vector

# Selective recording
**.server.**.vector-recording = true
**.client.**.vector-recording = false

# Warmup period (discard initial transient)
warmup-period = 100s

# Output file names
output-scalar-file = ${configname}-${runnumber}.sca
output-vector-file = ${configname}-${runnumber}.vec
```

### Recording Intervals
```ini
# Record vectors only in specific time range
**.vector-recording-intervals = 100s..200s

# Multiple intervals
**.vector-recording-intervals = 0s..10s, 90s..100s
```

## Accessing Results

### In finish() Method
```cpp
void MyModule::finish()
{
    // Record custom scalars
    recordScalar("totalPackets", packetCount);
    recordScalar("avgDelay", totalDelay / packetCount);
    
    // Record with unit
    recordScalar("throughput", throughput, "bps");
}
```

### Result Files
- `.sca` - Scalar results (single values)
- `.vec` - Vector results (time series)
- `.vci` - Vector index file

### Analysis Tools
- **OMNeT++ IDE**: Built-in Analysis Tool
- **opp_scavetool**: Command-line result processing
- **Python**: Use `omnetpp.scave` module

```bash
# Export to CSV
opp_scavetool export -o results.csv results/*.sca results/*.vec

# Filter and export
opp_scavetool export -f 'module=~"*.server"' -o server.csv results/*.vec
```
