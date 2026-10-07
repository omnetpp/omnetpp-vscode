---
name: omnetpp-modeling
description: |
  Guide for planning and implementing OMNeT++ discrete event simulation models. Use when creating network simulations, protocol models, queueing systems, or any discrete event simulation in OMNeT++. Covers: (1) Project structure and setup, (2) NED network topology definitions, (3) C++ simple module implementation, (4) Message definitions (.msg files), (5) Configuration (omnetpp.ini), (6) Signals and statistics collection, (7) Visualization and animation. Triggers on requests involving OMNeT++, network simulation, NED files, simulation models, or discrete event simulation.
---

# OMNeT++ Model Development

## Project Structure

Standard OMNeT++ project layout:
```
project/
├── package.ned          # Package declaration and namespace
├── omnetpp.ini          # Simulation configurations
├── *.ned                # Network and module definitions
├── *.msg                # Message definitions
├── *.cc / *.h           # C++ module implementations
├── .nedfolders          # NED source folders (contains ".")
├── .oppbuildspec        # Build configuration
└── .project / .cproject # IDE project files
```

## Planning Phase

### 1. Define the Model Scope
- Identify entities to simulate (nodes, channels, protocols)
- Determine message types and their fields
- Plan statistics to collect
- Sketch network topology

### 2. Design Module Hierarchy
- **Simple modules**: Implement behavior in C++ (leaf nodes)
- **Compound modules**: Compose simple/compound modules (containers)
- **Networks**: Top-level compound modules with `network` keyword

### 3. Plan Message Flow
- Identify self-messages (timers) vs external messages
- Define gate connections and directions
- Consider channel properties (delay, datarate, error rate)

## Implementation Phase

API and usage of OMNeT++ features can be queried from the DeepWiki server for the omnetpp/omnetpp repo.

### NED Files

#### Package Declaration (`package.ned`)
```ned
package org.example.mymodel;
@namespace(mymodel);  // C++ namespace
@license(LGPL);
```

#### Simple Module Definition
```ned
simple MyModule
{
    parameters:
        @display("i=block/process");  // Icon
        @signal[packetSent](type=long);
        @statistic[sentCount](source=packetSent; record=count,vector);
        
        double processingTime @unit(s) = default(1s);
        volatile double interArrivalTime @unit(s);  // volatile = evaluated each access
        int bufferSize = default(100);
        string protocol = default("TCP");
        bool enabled = default(true);
    gates:
        input in[];      // Gate vector (dynamic size)
        output out;      // Single gate
        inout port[];    // Bidirectional gate vector
}
```

#### Compound Module Definition
```ned
module Node
{
    parameters:
        int address;
        string appType = default("BasicApp");
        @display("i=misc/node");
    gates:
        inout port[];
    submodules:
        app: <appType> like IApp {  // Parametric submodule type
            @display("p=100,50");
        }
        routing: Routing {
            gates: in[sizeof(parent.port)]; out[sizeof(parent.port)];
        }
        queue[sizeof(port)]: Queue;
    connections:
        app.out --> routing.localIn;
        app.in <-- routing.localOut;
        for i=0..sizeof(port)-1 {
            routing.out[i] --> queue[i].in;
            routing.in[i] <-- queue[i].out;
            queue[i].line <--> port[i];
        }
}
```

#### Network Definition
```ned
import ned.DatarateChannel;

network MyNetwork
{
    parameters:
        int numNodes = default(10);
        @display("bgb=800,600");  // Canvas size
    types:
        channel C extends DatarateChannel {
            delay = 10ms;
            datarate = 100Mbps;
        }
    submodules:
        node[numNodes]: Node {
            address = index;
        }
    connections:
        node[0].port++ <--> C <--> node[1].port++;
        // Use ++ to auto-extend gate vectors
}
```

### Message Definitions (.msg)

```msg
namespace mymodel;

// Simple message
message MyMessage
{
    int sourceId;
    int destId;
    int hopCount = 0;
    simtime_t creationTime;
}

// Packet (has bit length)
packet DataPacket
{
    int srcAddr @packetData;   // Included in packet data display
    int destAddr @packetData;
    string payload;
}

// Customizable message (allows C++ class extension)
message Job
{
    @customize(true);
    int priority;
    simtime_t queueingTime;
}
```

### C++ Module Implementation

#### Header File Pattern
```cpp
#ifndef __MYMODEL_MYMODULE_H
#define __MYMODEL_MYMODULE_H

#include <omnetpp.h>

using namespace omnetpp;

namespace mymodel {

class MyModule : public cSimpleModule
{
  private:
    // Parameters
    simtime_t processingTime;
    
    // State
    cMessage *selfMsg = nullptr;
    cQueue queue;
    
    // Statistics
    simsignal_t packetSentSignal;
    
  protected:
    virtual void initialize() override;
    virtual void handleMessage(cMessage *msg) override;
    virtual void finish() override;
    virtual void refreshDisplay() const override;
    
  public:
    virtual ~MyModule();
};

}  // namespace

#endif
```

#### Implementation File Pattern
```cpp
#include "MyModule.h"
#include "MyMessage_m.h"  // Generated from .msg

namespace mymodel {

Define_Module(MyModule);

MyModule::~MyModule()
{
    cancelAndDelete(selfMsg);
}

void MyModule::initialize()
{
    // Read parameters
    processingTime = par("processingTime");
    
    // Register signals for statistics
    packetSentSignal = registerSignal("packetSent");
    
    // Initialize state
    queue.setName("queue");
    selfMsg = new cMessage("timer");
    
    // WATCH variables for GUI inspection
    WATCH(processingTime);
    
    // Bootstrap: schedule first event or send initial message
    if (par("enabled").boolValue()) {
        scheduleAt(simTime() + par("interArrivalTime").doubleValue(), selfMsg);
    }
}

void MyModule::handleMessage(cMessage *msg)
{
    if (msg->isSelfMessage()) {
        // Timer expired - process and reschedule
        EV << "Timer fired at " << simTime() << endl;
        
        // Create and send a message
        MyMessage *pkt = new MyMessage("data");
        pkt->setSourceId(getId());
        send(pkt, "out");
        emit(packetSentSignal, 1);
        
        // Reschedule
        scheduleAt(simTime() + par("interArrivalTime").doubleValue(), selfMsg);
    }
    else {
        // External message arrived
        MyMessage *pkt = check_and_cast<MyMessage *>(msg);
        EV << "Received packet from " << pkt->getSourceId() << endl;
        
        // Process or forward
        pkt->setHopCount(pkt->getHopCount() + 1);
        send(pkt, "out");
    }
}

void MyModule::refreshDisplay() const
{
    // Update visual appearance
    char buf[40];
    snprintf(buf, sizeof(buf), "q: %d", queue.getLength());
    getDisplayString().setTagArg("t", 0, buf);
}

void MyModule::finish()
{
    // Record final statistics
    recordScalar("totalProcessed", queue.getLength());
}

}  // namespace
```

### Configuration (omnetpp.ini)

```ini
[General]
network = MyNetwork
sim-time-limit = 100s
# debug-on-errors = true
# record-eventlog = true

# Wildcard parameter assignment
**.processingTime = 100ms
**.bufferSize = ${bufSize=10,50,100}  # Parameter study

[Config Baseline]
description = "Baseline configuration"
MyNetwork.numNodes = 10
**.interArrivalTime = exponential(1s)

[Config HighLoad]
extends = Baseline
description = "High load scenario"
**.interArrivalTime = exponential(100ms)
repeat = 5  # Multiple replications

[Config Experiment]
description = "Parameter sweep"
**.interArrivalTime = exponential(${iaMean=0.1..1.0 step 0.1}s)
**.bufferSize = ${bufSize=10,50,100}
```

## Key Patterns

### Self-Messages (Timers)
```cpp
// Create once in initialize()
timer = new cMessage("timer");
scheduleAt(simTime() + delay, timer);

// In handleMessage()
if (msg->isSelfMessage()) {
    // Handle timeout
    scheduleAt(simTime() + nextDelay, timer);
}

// Cleanup in destructor
cancelAndDelete(timer);
```

### Gate Operations
```cpp
// Send on named gate
send(msg, "out");

// Send on gate vector
send(msg, "out", gateIndex);

// Send with delay/duration (for wireless)
sendDirect(msg, propagationDelay, transmissionDuration, targetModule->gate("in"));

// Get gate info
int n = gateSize("in");
cGate *g = gate("out", i);
```

### Module Lookup
```cpp
// By path
cModule *server = getModuleByPath("server");
cModule *parent = getParentModule();
cModule *sibling = getParentModule()->getSubmodule("other");

// By parameter
int addr = getParentModule()->par("address");
```

### Statistics Collection
```cpp
// In NED
@signal[queueLength](type=long);
@statistic[queueLen](source=queueLength; title="Queue Length"; 
    record=vector,timeavg,max; interpolationmode=sample-hold);

// In C++
simsignal_t signal = registerSignal("queueLength");
emit(signal, queue.getLength());
```

### Topology Discovery
```cpp
cTopology topo;
topo.extractByNedTypeName({"mymodel.Node"});
cTopology::Node *thisNode = topo.getNodeFor(getParentModule());
topo.calculateUnweightedSingleShortestPathsTo(destNode);
int outGate = thisNode->getPath(0)->getLocalGate()->getIndex();
```

## Common Display String Tags

| Tag | Purpose | Example |
|-----|---------|---------|
| `i` | Icon | `i=block/queue` |
| `i2` | Overlay icon | `i2=status/busy` |
| `p` | Position | `p=100,200` |
| `b` | Box shape | `b=40,40,rect,yellow` |
| `t` | Text label | `t=processing` |
| `tt` | Tooltip | `tt=Click for details` |

## Debugging Tips

1. Use `EV << "message" << endl;` for logging
2. Enable `debug-on-errors = true` in omnetpp.ini
3. Use `WATCH(variable)` to inspect in GUI
4. Use `bubble("text")` for visual feedback
5. Check `hasGUI()` before GUI-only operations

## See Also

- [references/ned-syntax.md](references/ned-syntax.md) - Complete NED language reference
- [references/statistics.md](references/statistics.md) - Detailed statistics and signals guide
- [references/channels.md](references/channels.md) - Channel types and properties
