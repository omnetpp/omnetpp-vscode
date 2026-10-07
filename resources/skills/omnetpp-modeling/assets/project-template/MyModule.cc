#include "MyModule.h"

namespace myproject {

Define_Module(MyModule);

MyModule::~MyModule()
{
    cancelAndDelete(processTimer);
}

void MyModule::initialize()
{
    // Read parameters
    processingTime = par("processingTime");
    
    // Register signals
    processedSignal = registerSignal("processed");
    
    // Initialize timer
    processTimer = new cMessage("processTimer");
    
    // WATCH for GUI inspection
    WATCH(processedCount);
    
    // Start processing cycle
    scheduleAt(simTime() + processingTime, processTimer);
}

void MyModule::handleMessage(cMessage *msg)
{
    if (msg->isSelfMessage()) {
        // Timer expired
        EV << "Processing completed at " << simTime() << endl;
        processedCount++;
        emit(processedSignal, 1);
        
        // Create and send a message
        cMessage *outMsg = new cMessage("data");
        send(outMsg, "out");
        
        // Reschedule
        scheduleAt(simTime() + processingTime, processTimer);
    }
    else {
        // External message received
        EV << "Received message: " << msg->getName() << endl;
        delete msg;
    }
}

void MyModule::finish()
{
    recordScalar("totalProcessed", processedCount);
}

}  // namespace myproject
