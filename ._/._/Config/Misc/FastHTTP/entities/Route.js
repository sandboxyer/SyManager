import Component from "./Component.js";

class Route extends Component {

    static async New(data = {Name : 'New Route',Method : 'post',Url : 'http://localhost:3000/',GroupID : undefined}){
        let objcreation = {
            Name : data.Name || 'New Route',
            Type : 'route',
            Method : data.Method || 'post',
            Url : data.Url || 'http://localhost:3000/',
            GroupID : data.GroupID || undefined
        }
        return await this.Model.create(objcreation)
    }

}

export default Route