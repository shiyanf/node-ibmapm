# Bind the Availabitliy Monitoring service

1. In the `package.json` file of your application, add the following line to the dependencies section:
    ```
    ibmapm":"^2.0.0"
    ```
2. Add the following line to the beginning of the main file of your Node.js
application:
    ```
    require('ibmapm');
    ```
    **Tip**: If you start your application by running the node app.js command, `app.js` is the main file of your application.

3. Create an Availability Monitoring service instance in IBM Cloud and
remember the service instance name.
    
    **Tip**: To create an Availability Monitoring service instance in the IBM Cloud UI, click **Menu** > **Application Services** > **Create Application Service**, and search *Availability Monitoring*.
4. In the manifest.yml file of your application or the IBM Cloud UI, set the following variables:
    ```
    services:
    - <Avilability_Monitoring_service_instance_name>
    ```
    *`<Avilability_Monitoring_service_instance_name>`* is the name of the Availability Monitoring service instance that you create in the previous step, for example, `Availability Monitoring-bh`.
