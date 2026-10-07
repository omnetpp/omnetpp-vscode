#ifndef __MYPROJECT_MYMODULE_H
#define __MYPROJECT_MYMODULE_H

#include <omnetpp.h>

using namespace omnetpp;

namespace myproject {

class MyModule : public cSimpleModule
{
  private:
    // Parameters
    simtime_t processingTime;
    
    // State
    cMessage *processTimer = nullptr;
    
    // Statistics
    simsignal_t processedSignal;
    int processedCount = 0;
    
  protected:
    virtual void initialize() override;
    virtual void handleMessage(cMessage *msg) override;
    virtual void finish() override;
    
  public:
    virtual ~MyModule();
};

}  // namespace myproject

#endif
