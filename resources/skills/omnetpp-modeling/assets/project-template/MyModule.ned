//
// Example simple module definition
//
simple MyModule
{
    parameters:
        @display("i=block/process");
        @signal[processed](type=long);
        @statistic[processedCount](source=processed; title="Processed"; record=count,vector);
        
        double processingTime @unit(s) = default(100ms);
        
    gates:
        input in;
        output out;
}

//
// Example network using the module
//
network MyNetwork
{
    parameters:
        @display("bgb=400,200");
    submodules:
        source: MyModule {
            @display("p=100,100");
        }
        sink: MyModule {
            @display("p=300,100");
        }
    connections:
        source.out --> { delay = 10ms; } --> sink.in;
}
