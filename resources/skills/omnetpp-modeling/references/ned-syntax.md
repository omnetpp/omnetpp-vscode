# NED Language Reference

## Table of Contents
- [Package and Imports](#package-and-imports)
- [Simple Modules](#simple-modules)
- [Compound Modules](#compound-modules)
- [Networks](#networks)
- [Channels](#channels)
- [Module Interfaces](#module-interfaces)
- [Parameters](#parameters)
- [Gates](#gates)
- [Connections](#connections)
- [Properties](#properties)
- [Expressions](#expressions)

## Package and Imports

```ned
// Package declaration (must match directory structure)
package org.example.myproject;

// Import specific types
import org.example.other.SomeModule;

// Import all from package
import org.example.other.*;

// Import from OMNeT++ library
import ned.DatarateChannel;
import ned.IdealChannel;
import ned.DelayChannel;
```

## Simple Modules

Simple modules are implemented in C++:

```ned
simple Source
{
    parameters:
        @class(myns::Source);  // Explicit C++ class (optional)
        @display("i=block/source");
        
        volatile double sendInterval @unit(s) = default(exponential(1s));
        int numToSend = default(-1);  // -1 = unlimited
        
    gates:
        output out;
}
```

## Compound Modules

Compound modules compose other modules:

```ned
module Router
{
    parameters:
        int numPorts;
        @display("i=abstract/router");
        
    gates:
        inout port[numPorts];
        
    submodules:
        routing: RoutingTable;
        queue[numPorts]: Queue {
            @display("p=100,100,row,100");  // Arrange in row
        }
        
    connections allowunconnected:
        for i=0..numPorts-1 {
            routing.out[i] --> queue[i].in;
            queue[i].line <--> port[i];
        }
}
```

## Networks

Networks are top-level compound modules:

```ned
network SimpleNetwork
{
    parameters:
        int n = default(6);
        
    types:
        channel Link extends ned.DatarateChannel {
            delay = 10ms;
            datarate = 1Gbps;
        }
        
    submodules:
        node[n]: Node;
        
    connections:
        for i=0..n-2 {
            node[i].port++ <--> Link <--> node[i+1].port++;
        }
}
```

## Channels

### Built-in Channel Types
- `ned.IdealChannel` - Zero delay, no data rate limit
- `ned.DelayChannel` - Propagation delay only
- `ned.DatarateChannel` - Delay + datarate + bit error rate

### Custom Channel
```ned
channel WirelessChannel extends ned.DatarateChannel
{
    parameters:
        delay = default(1us);
        datarate = default(54Mbps);
        ber = default(1e-6);  // Bit error rate
        per = default(0);     // Packet error rate
        @display("ls=red,2");  // Line style
}
```

### Channel Usage in Connections
```ned
connections:
    // Named channel type
    a.out --> WirelessChannel --> b.in;
    
    // Inline channel spec
    a.out --> { delay = 5ms; datarate = 100Mbps; } --> b.in;
    
    // Bidirectional
    a.port <--> WirelessChannel <--> b.port;
    
    // No channel (ideal)
    a.out --> b.in;
```

## Module Interfaces

Define contracts for parametric submodule types:

```ned
moduleinterface IApp
{
    parameters:
        int address;
    gates:
        input in;
        output out;
}

simple BasicApp like IApp
{
    parameters:
        int address;
        double sendInterval @unit(s);
    gates:
        input in;
        output out;
}

// Usage with parametric type
module Node
{
    parameters:
        string appType = default("BasicApp");
    submodules:
        app: <appType> like IApp;
}
```

## Parameters

### Parameter Types
```ned
parameters:
    int count = default(10);
    double rate @unit(bps) = default(1Mbps);
    string protocol = default("TCP");
    bool enabled = default(true);
    xml config;  // XML parameter
    object data;  // Any NED value
    
    // Volatile: re-evaluated on each par() access
    volatile double delay @unit(s) = default(exponential(1s));
    volatile int size @unit(byte) = default(intuniform(64byte, 1500byte));
```

### Parameter Properties
```ned
parameters:
    double x @unit(m);           // Unit specification
    int y @mutable;              // Can be changed at runtime
    string z @prompt("Enter Z"); // Prompt user if not set
    double w = default(1) @unit(s);  // Default with unit
```

### Pattern-Based Assignment (omnetpp.ini)
```ini
# Exact match
Network.node[0].app.sendInterval = 1s

# Wildcard patterns
**.sendInterval = 2s           # Any sendInterval anywhere
*.node[*].app.sendInterval = 3s  # All nodes' apps
**.node[0..4].** = 100         # Nodes 0-4
**.queue*.capacity = 50        # Any queue module
```

## Gates

### Gate Types
```ned
gates:
    input in;           // Single input
    output out;         // Single output
    inout port;         // Bidirectional
    
    input in[];         // Input vector (size set by connections)
    output out[4];      // Fixed-size output vector
    inout port[];       // Bidirectional vector
```

### Gate Properties
```ned
gates:
    input in @directIn;  // Accepts sendDirect()
    input in @loose;     // Connection optional
```

## Connections

### Connection Syntax
```ned
connections:
    // Unidirectional
    source.out --> sink.in;
    source.out --> { delay = 10ms; } --> sink.in;
    source.out --> Channel --> sink.in;
    
    // Bidirectional
    a.port <--> b.port;
    a.port <--> Channel <--> b.port;
    
    // Gate vector expansion
    a.out++ --> b.in++;  // Auto-extend vectors
    
    // Indexed
    a.out[0] --> b.in[0];
    
    // Loop
    for i=0..n-1 {
        node[i].out --> node[(i+1)%n].in;
    }

connections allowunconnected:
    // Gates don't have to be connected
```

## Properties

### Module Properties
```ned
@display("i=icon;p=x,y");     // Visual appearance
@class(namespace::ClassName); // C++ class binding
@namespace(ns);               // C++ namespace for package
@license(GPL);                // License info
```

### Signal and Statistic Properties
```ned
@signal[packetSent](type=cPacket);
@signal[queueLength](type=long);

@statistic[sentBytes](
    source=sum(packetBytes(packetSent));
    title="Total bytes sent";
    unit=byte;
    record=last,vector;
    interpolationmode=none
);

@statistic[queueLen](
    source=queueLength;
    record=vector,timeavg,max,histogram;
    interpolationmode=sample-hold
);
```

## Expressions

### Operators
- Arithmetic: `+ - * / % ^`
- Comparison: `== != < > <= >=`
- Logical: `&& || ! ?:`
- String: `+` (concatenation)

### Built-in Functions
```ned
// Random
uniform(0, 10)
exponential(1s)
normal(0, 1)
truncnormal(5, 1)
intuniform(1, 6)

// Math
min(a, b), max(a, b)
floor(x), ceil(x)
sqrt(x), exp(x), log(x)
sin(x), cos(x), atan2(y, x)

// String
length(s)
contains(s, substr)
substring(s, pos, len)
replace(s, old, new)

// Module
index           // Submodule array index
sizeof(gate)    // Gate vector size
ancestorIndex(level)

// Special
default(value)  // Default if not assigned
xmldoc(filename)
```

### Examples
```ned
parameters:
    int n = default(sizeof(port));
    double delay @unit(s) = default(distance/speedOfLight);
    string name = default("node" + string(index));
    
submodules:
    queue[sizeof(parent.port)]: Queue;
    
connections:
    for i=0..sizeof(port)-1 {
        routing.out[i] --> queue[i].in;
    }
```
