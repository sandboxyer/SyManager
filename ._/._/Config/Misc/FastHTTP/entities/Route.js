import Component from "./Component.js";

class Route extends Component {

    static async New(name){
        return await this.Model.create({Name : name,Type : 'route',Method : 'post',Url : 'http://localhost:3000/'})
    }

}

export default Route